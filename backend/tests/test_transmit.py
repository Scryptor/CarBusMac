import asyncio

import pytest

from app.models import CanFrame
from app.transmit import TransmitManager, TriggerSpec, TxTask, task_from_dict, task_to_dict


def _collect(sent):
    async def send(f):
        sent.append(f)
    return send


class FakeSleep:
    """Сон, который записывает задержки и отдаёт управление циклу событий."""

    def __init__(self, limit=None):
        self.calls = []
        self.limit = limit

    async def __call__(self, d):
        self.calls.append(d)
        if self.limit is not None and len(self.calls) >= self.limit:
            raise asyncio.CancelledError
        await asyncio.sleep(0)


async def _drain():
    for _ in range(10):
        await asyncio.sleep(0)


async def test_send_once_counts_and_sends():
    sent = []
    tm = TransmitManager(send=_collect(sent))
    tm.upsert(TxTask(id="t", channel=2, can_id=0x7E0, data=b"\x02\x3e\x00"))
    await tm.send_once("t")
    assert sent[0].can_id == 0x7E0 and sent[0].channel == 2 and sent[0].data == b"\x02\x3e\x00"
    assert tm.tasks[0].count == 1


async def test_shot_sends_frame_without_task():
    sent = []
    tm = TransmitManager(send=_collect(sent))
    await tm.shot(CanFrame(1, 0x123, b"\x01"))
    assert [f.can_id for f in sent] == [0x123] and tm.tasks == []


async def test_periodic_loop_uses_period_and_pause_stops():
    sent = []
    sleep = FakeSleep()
    tm = TransmitManager(send=_collect(sent), sleep=sleep)
    tm.upsert(TxTask(id="t", can_id=0x100, data=b"\x00", period_ms=10))
    tm.start("t")
    await _drain()
    assert tm.tasks[0].running and len(sent) >= 2 and sleep.calls[0] == pytest.approx(0.01)
    tm.pause("t")
    n = len(sent)
    await _drain()
    assert not tm.tasks[0].running and len(sent) == n
    assert tm.tasks[0].count == n


async def test_start_all_and_pause_all():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="a", can_id=1))
    tm.upsert(TxTask(id="b", can_id=2))
    tm.start_all()
    await _drain()
    assert {f.can_id for f in sent} == {1, 2} and all(t.running for t in tm.tasks)
    tm.pause_all()
    assert not any(t.running for t in tm.tasks)


async def test_trigger_single_with_dont_care_bytes():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="t", can_id=0x321, data=b"\x01",
                     trigger=TriggerSpec(action="single", can_id=0x123, data=[0x10, None] + [None] * 6)))
    await tm.on_frame(CanFrame(1, 0x123, b"\x10\x99"))
    await tm.on_frame(CanFrame(1, 0x123, b"\x11\x99"))
    await _drain()
    assert [f.can_id for f in sent] == [0x321]


async def test_trigger_channel_dlc_and_ext_must_match():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="t", can_id=0x321,
                     trigger=TriggerSpec(action="single", channel=2, can_id=0x123, dlc=2)))
    await tm.on_frame(CanFrame(1, 0x123, b"\x00\x00"))               # не тот канал
    await tm.on_frame(CanFrame(2, 0x123, b"\x00"))                   # не тот DLC
    await tm.on_frame(CanFrame(2, 0x123, b"\x00\x00", extended=True))  # 29-бит
    await tm.on_frame(CanFrame(2, 0x123, b"\x00\x00"))
    await _drain()
    assert len(sent) == 1


async def test_trigger_start_and_stop_control_cycle():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="go", can_id=0x500, period_ms=100,
                     trigger=TriggerSpec(action="start", can_id=0x1)))
    tm.upsert(TxTask(id="halt", can_id=0x501,
                     trigger=TriggerSpec(action="none")))
    tm.upsert(TxTask(id="stopper", can_id=0x502, trigger=TriggerSpec(action="stop", can_id=0x2)))
    await tm.on_frame(CanFrame(1, 0x1, b""))
    await _drain()
    assert tm.tasks[0].running
    # «stop» останавливает свою задачу (stopper), не трогая чужие
    tm.start("stopper")
    await tm.on_frame(CanFrame(1, 0x2, b""))
    await _drain()
    assert not tm.tasks[2].running and tm.tasks[0].running


async def test_trigger_respects_delay():
    sent = []
    sleep = FakeSleep()
    tm = TransmitManager(send=_collect(sent), sleep=sleep)
    tm.upsert(TxTask(id="t", can_id=0x321, trigger=TriggerSpec(action="single", delay_ms=250, can_id=0x123)))
    await tm.on_frame(CanFrame(1, 0x123, b""))
    await _drain()
    assert sleep.calls[0] == pytest.approx(0.25) and len(sent) == 1


async def test_tx_frames_do_not_fire_triggers():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="t", can_id=0x321, trigger=TriggerSpec(action="single", can_id=0x123)))
    await tm.on_frame(CanFrame(1, 0x123, b"", direction="tx"))
    await _drain()
    assert sent == []


async def test_reset_counters_delete_and_clear():
    changes = []
    tm = TransmitManager(send=_collect([]), on_change=lambda: changes.append(1))
    tm.upsert(TxTask(id="a", can_id=1))
    tm.upsert(TxTask(id="b", can_id=2))
    await tm.send_once("a")
    await tm.send_once("b")
    tm.reset("a")
    assert [t.count for t in tm.tasks] == [0, 1]
    tm.reset(None)
    assert [t.count for t in tm.tasks] == [0, 0]
    tm.delete("a")
    assert [t.id for t in tm.tasks] == ["b"]
    tm.clear()
    assert tm.tasks == [] and changes


async def test_upsert_running_task_restarts_with_new_frame():
    sent = []
    tm = TransmitManager(send=_collect(sent), sleep=FakeSleep())
    tm.upsert(TxTask(id="t", can_id=0x100, period_ms=10))
    tm.start("t")
    await _drain()
    tm.upsert(TxTask(id="t", can_id=0x200, period_ms=10, running=True))
    sent.clear()
    await _drain()
    assert sent and all(f.can_id == 0x200 for f in sent) and tm.tasks[0].running


def test_task_dict_roundtrip():
    t = TxTask(id="t1", channel=2, can_id=0x18DAF110, ext=True, rtr=False, data=b"\x02\x3e\x00",
               period_ms=500, comment="tester", count=3,
               trigger=TriggerSpec(action="stop", delay_ms=5, channel=1, can_id=0x7E8, dlc=3,
                                   data=[2, None, 0] + [None] * 5))
    d = task_to_dict(t)
    assert d["data"] == "023e00" and d["trigger"]["data"][1] is None
    back = task_from_dict(d)
    assert back == TxTask(**{**t.__dict__, "running": False})


def test_task_from_dict_validates():
    with pytest.raises(ValueError):
        task_from_dict({"id": "x", "can_id": 0x800, "ext": False})          # >11 бит
    with pytest.raises(ValueError):
        task_from_dict({"id": "x", "can_id": 1, "data": "0011223344556677ff"})  # 9 байт
    with pytest.raises(ValueError):
        task_from_dict({"id": "x", "can_id": 1, "period_ms": 0})
