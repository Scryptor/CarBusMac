"""Жизненный цикл подключения и фильтров: висящий мост, отмена, отказ прибора,
событие конфигурации, сохранение раскладки слотов, защита от NaN, остановка лога."""
import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.can_session import FakeSession
from app.hub import Hub
from app.models import CanFrame
from app.server import create_app
from app.store import JsonStore

from tests.test_hub import CONNECT, CONNECT_TX, INFO, call, recv_until


class HangingSession(FakeSession):
    """Мост принял TCP и молчит: connect() не возвращается, пока его не отменят."""

    async def connect(self) -> None:
        await asyncio.Event().wait()


class RejectingFilters(FakeSession):
    async def set_hw_filter(self, channel, index, can_id, mask, extended):
        raise RuntimeError("Device ERROR")


def _app(tmp_path, cls=FakeSession, info=INFO):
    sessions = []

    def factory(cfg=None, device=None):
        s = cls(info=info)
        sessions.append(s)
        return s

    app = create_app(factory, data_dir=tmp_path / "data", traces_dir=tmp_path / "traces",
                     allowed_hosts=("testserver",))
    return app, sessions


def test_hanging_connect_does_not_block_the_tab_and_disconnect_cancels_it(tmp_path):
    app, _ = _app(tmp_path, HangingSession)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "connect", "config": CONNECT, "req_id": 900})
        recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "opening")
        t0 = time.monotonic()
        r = call(ws, type="disconnect")                 # та же вкладка — команда не ждёт подключения
        assert r["ok"] and time.monotonic() - t0 < 2
        rep = recv_until(ws, lambda m: m.get("type") == "reply" and m.get("req_id") == 900)
        assert rep["ok"] is False
        st = recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "closed")
        assert st["state"] == "closed"


def test_connect_broadcasts_connection_config(tmp_path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="connect", config=CONNECT)["ok"]
        ev = recv_until(ws, lambda m: m["type"] == "connection")
        assert ev["connection"]["channels"][0]["listen_only"] is True
        assert ev["connection"]["channels"][0]["alias"] == "Кузов"


def test_device_rejecting_a_filter_does_not_hang_connect(tmp_path):
    (tmp_path / "data").mkdir(parents=True)
    (tmp_path / "data" / "filters.json").write_text(json.dumps(
        {"hw": [{"channel": 1, "index": 0, "enabled": True, "can_id": 0x120, "mask": 0x7FF, "ext": False}]}))
    app, sessions = _app(tmp_path, RejectingFilters)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="connect", config=CONNECT)["ok"]
        recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "opened")
        toast = recv_until(ws, lambda m: m["type"] == "toast" and m["level"] == "warning")
        assert "фильтр" in toast["message"]


def test_hw_set_rejected_by_device_changes_nothing(tmp_path):
    app, _ = _app(tmp_path, RejectingFilters)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="connect", config=CONNECT)["ok"]
        r = call(ws, type="hw_set", slot={"channel": 1, "index": 0, "enabled": True, "can_id": 0x120,
                                          "mask": 0x7FF, "ext": False})
        assert r["ok"] is False
        hw = client.app.state.hub.hw
        assert hw.slots[0].enabled is False and hw.slots[0].can_id == 0


def test_add_id_keeps_configured_slots_and_reuses_own(tmp_path):
    hub = Hub(lambda *a: FakeSession(), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")
    hub.settings["filter_new_active"] = False

    async def run():
        # пользователь временно выключил свой фильтр 0x555 в слоте 0
        await hub._cmd_hw_set({"slot": {"channel": 1, "index": 0, "enabled": False, "can_id": 0x555,
                                        "mask": 0x7FF, "ext": False}})
        a = await hub._cmd_filters_add_id({"channel": 1, "id": 0x120})
        b = await hub._cmd_filters_add_id({"channel": 1, "id": 0x200})
        c = await hub._cmd_filters_add_id({"channel": 1, "id": 0x120})
        return a["index"], b["index"], c["index"]
    a, b, c = asyncio.run(run())
    assert hub.hw.slots[0].can_id == 0x555
    assert a != b and a != 0 and b != 0 and c == a


def test_slots_beyond_default_layout_survive_restart(tmp_path):
    info = {**INFO, "filters_info": [{"channel": 1, "size": 4}, {"channel": 2, "size": 20}]}
    hub = Hub(lambda *a: FakeSession(info=info), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")

    async def run():
        await hub._cmd_connect({"config": CONNECT})
        await hub._cmd_hw_set({"slot": {"channel": 2, "index": 17, "enabled": True, "can_id": 0x3FB,
                                        "mask": 0x7FF, "ext": False}})
        await hub._cmd_disconnect({})
    asyncio.run(run())
    again = Hub(lambda *a: FakeSession(), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")
    s = next(s for s in again.hw.slots if s.channel == 2 and s.index == 17)
    assert s.enabled and s.can_id == 0x3FB


def test_separate_29_bit_bank_is_respected():
    from app.filters import HwFilters, HwSlot, layout_from_device, layout_kinds
    info = {"filters_info": [{"channel": 1, "size": 2, "has_11bit": True, "has_29bit": False},
                             {"channel": 1, "size": 2, "has_11bit": False, "has_29bit": True}]}
    hw = HwFilters(layout_from_device(info), layout_kinds(info))
    with pytest.raises(ValueError, match="только для 11-битных"):
        hw.set(HwSlot(1, 0, True, 0x18DAF110, 0x1FFFFFFF, True))
    assert hw.slot_for_id(1, 0x18DAF110, True).index == 2
    assert hw.slot_for_id(1, 0x120, False).index == 0


def test_nan_and_infinity_are_rejected(tmp_path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_text('{"type": "bitrates_set", "req_id": 77, "bitrates": [{"caption": "x", "bitrate": 1, '
                     '"sample_pct": Infinity, "timing": {"prescaler": 1, "seg1": 1, "seg2": 1, "sjw": 1}}]}')
        r = recv_until(ws, lambda m: m.get("type") == "reply" and m.get("req_id") == 77)
        assert r["ok"] is False
        assert client.app.state.hub.bitrates == []


def test_shutdown_finishes_background_log(tmp_path):
    hub = Hub(lambda *a: FakeSession(info=INFO), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")
    hub.settings["log_autostart"] = True

    async def run():
        await hub._cmd_connect({"config": CONNECT_TX})
        await hub._on_rx(CanFrame(1, 0x120, b"\x01", timestamp=1.0))
        await hub.shutdown()
    asyncio.run(run())
    names = sorted(p.name for p in (tmp_path / "traces").iterdir())
    assert len(names) == 1 and names[0].endswith(".trc")


def test_connect_reconnect_disconnect_race_ends_closed_with_every_session_closed(tmp_path):
    """«Принять», снова «Принять», «Отменить подключение» подряд, пока прибор тянет с
    ответом: хаб отключён, ни одной открытой сессии к мосту."""
    release = asyncio.Event()
    made = []

    class Slow(FakeSession):
        async def open_channel(self, channel, bitrate, listen_only, timing=None):
            await release.wait()
            await super().open_channel(channel, bitrate, listen_only, timing)

        async def close(self):
            await asyncio.sleep(0.01)                # DEVICE_CLOSE тоже не мгновенный
            await super().close()

    def factory(cfg=None, device=None):
        s = Slow(info=INFO)
        made.append(s)
        return s

    hub = Hub(factory, JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")

    async def spin(n=20):
        for _ in range(n):
            await asyncio.sleep(0)

    async def run():
        a = asyncio.create_task(hub._cmd_connect({"config": CONNECT}))
        await spin()                                  # A повис на открытии канала
        b = asyncio.create_task(hub._cmd_connect({"config": CONNECT}))
        await spin(3)                                 # B ждёт, пока A закроется
        await hub._cmd_disconnect({})                 # «Отменить подключение»
        release.set()
        await asyncio.gather(a, b, return_exceptions=True)
        await asyncio.sleep(0.05)

    asyncio.run(run())
    assert hub.state == "closed" and hub.session is None
    assert made and all(not s.connected for s in made)


def test_add_id_does_not_touch_an_existing_filter_with_another_mask(tmp_path):
    hub = Hub(lambda *a: FakeSession(), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")

    async def run():
        await hub._cmd_hw_set({"slot": {"channel": 1, "index": 0, "enabled": True, "can_id": 0x120,
                                        "mask": 0x7F0, "ext": False}})
        r = await hub._cmd_filters_add_id({"channel": 1, "id": 0x120})
        again = await hub._cmd_filters_add_id({"channel": 1, "id": 0x120})
        return r["index"], again["index"]
    first, again = asyncio.run(run())
    s0 = hub.hw.slots[0]
    assert (s0.can_id, s0.mask, s0.enabled) == (0x120, 0x7F0, True)   # пользовательский фильтр цел
    assert first != 0 and again == first
