import asyncio

from app.models import CanFrame
from app.can_session import FakeSession
from app.transmit import TransmitManager, TxTask, Trigger


async def test_shot_sends_once():
    s = FakeSession()
    await s.connect()
    await TransmitManager(s).shot(CanFrame(1, 0x7E0, b"\x02\x3e\x00"))
    assert len(s.sent) == 1 and s.sent[0].can_id == 0x7E0


async def test_trigger_fires_on_masked_match():
    s = FakeSession()
    await s.connect()
    tm = TransmitManager(s)
    tm.add_trigger(Trigger(1, 0x123, b"\x10", b"\xf0", CanFrame(1, 0x321, b"\x01")))
    await tm.on_frame(CanFrame(1, 0x123, b"\x1A"))   # 0x1A & 0xF0 == 0x10 → match
    await tm.on_frame(CanFrame(1, 0x123, b"\x2A"))   # 0x2A & 0xF0 == 0x20 → no
    await tm.on_frame(CanFrame(2, 0x123, b"\x10"))   # другой канал → no
    assert [f.can_id for f in s.sent] == [0x321]


async def test_trigger_short_mask_does_not_crash():
    s = FakeSession()
    await s.connect()
    tm = TransmitManager(s)
    # маска короче данных — не должно падать IndexError
    tm.add_trigger(Trigger(1, 0x10, b"\x10\x20", b"\xf0", CanFrame(1, 0x99, b"")))
    await tm.on_frame(CanFrame(1, 0x10, b"\x1A\x20"))  # byte0 1A&F0=10 match; byte1 без маски
    assert [f.can_id for f in s.sent] == [0x99]


async def test_periodic_repeats_then_stops():
    s = FakeSession()
    await s.connect()

    async def fake_sleep(_d):
        if len(s.sent) >= 3:
            raise asyncio.CancelledError

    tm = TransmitManager(s, sleep=fake_sleep)
    tid = tm.add_task(TxTask(id="t1", frame=CanFrame(1, 0x111, b"\x01"), period_ms=10))
    await tm.run(tid)
    await asyncio.gather(tm.tasks[tid], return_exceptions=True)
    assert len(s.sent) == 3
    assert all(f.can_id == 0x111 for f in s.sent)
