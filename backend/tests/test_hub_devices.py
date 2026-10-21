"""Хаб и приборы на USB: снимок в hello, слежение за подключением/отключением прибора,
выбор прибора при подключении, опрос по другому адресу моста."""
import asyncio

import pytest

from app import hub as hub_mod
from app.can_session import FakeSession
from app.devices import empty_snapshot, entry
from app.hub import CommandError, Hub, normalize_connection
from app.store import JsonStore
from app.usbports import describe

from tests.test_hub import CONNECT, INFO

HACKER = entry("bridge", {**describe("/dev/cu.usbmodem00000000001A1",
                                     product="CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201",
                                     manufacturer="Spectratek", vid=0x0483, pid=0x5740), "busy": False})


class Client:
    def __init__(self):
        self.got: list[dict] = []

    def send(self, msg):
        self.got.append(msg)

    def of(self, kind):
        return [m for m in self.got if m.get("type") == kind]


class Discover:
    """Подменный поиск: что «воткнуто» сейчас — в self.devices."""

    def __init__(self, devices=(), state="ok"):
        self.devices = list(devices)
        self.state = state
        self.calls: list[dict] = []

    async def __call__(self, cfg):
        self.calls.append(dict(cfg))
        snap = empty_snapshot(cfg, self.state)
        snap["devices"] = [dict(d) for d in self.devices]
        if not self.devices:
            snap["hint"] = "Мост работает, но CAN-Hacker не подключён по USB."
        return snap


def make_hub(tmp_path, discover, made=None):
    def factory(cfg=None, device=None):
        s = FakeSession(info=INFO)
        if made is not None:
            made.append((cfg, device, s))
        return s
    return Hub(factory, JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data", discover=discover)


async def _spin(pred, timeout=2.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        assert loop.time() < end
        await asyncio.sleep(0.005)


def test_plugging_the_device_in_shows_up_without_reopening_anything(tmp_path, monkeypatch):
    monkeypatch.setattr(hub_mod, "DEVICE_POLL_S", 0.01)
    disc = Discover()
    hub = make_hub(tmp_path, disc)
    ui = Client()

    async def run():
        await hub.attach(ui)
        assert ui.got[0]["devices"]["bridge"]["state"] == "unknown"     # до первого опроса
        await _spin(lambda: ui.of("devices"))
        assert ui.of("devices")[-1]["devices"] == []
        disc.devices = [HACKER]                                         # воткнули в USB
        await _spin(lambda: ui.of("devices")[-1]["devices"])
        n = len(ui.of("devices"))
        await asyncio.sleep(0.05)
        assert len(ui.of("devices")) == n                               # без изменений — без событий
        hub.detach(ui)
        calls = len(disc.calls)
        await asyncio.sleep(0.05)
        assert len(disc.calls) == calls                                 # интерфейс закрыт — не опрашиваем
        await hub.shutdown()
    asyncio.run(run())


def test_connect_goes_to_the_found_device_and_status_names_it(tmp_path):
    made = []
    hub = make_hub(tmp_path, Discover([HACKER]), made)
    ui = Client()

    async def run():
        hub.clients.add(ui)
        await hub._cmd_connect({"config": CONNECT})
        cfg, device, _ = made[-1]
        assert device["key"] == "bridge:/dev/cu.usbmodem00000000001A1" and cfg["device"] == ""
        st = ui.of("status")[-1]
        assert st["state"] == "opened" and st["device"]["title"] == "CAN-Hacker v3.2"
        await hub._cmd_disconnect({})
        assert ui.of("status")[-1]["device"] is None
        await hub.shutdown()
    asyncio.run(run())


def test_connect_without_a_device_explains_why(tmp_path):
    made = []
    hub = make_hub(tmp_path, Discover([]), made)

    async def run():
        with pytest.raises(CommandError, match="не подключён по USB"):
            await hub._cmd_connect({"config": CONNECT})
        assert hub.state == "error" and "не подключён по USB" in hub.message
        assert made == []                                               # к мосту даже не ходили
        await hub.shutdown()
    asyncio.run(run())


def test_scan_of_another_bridge_address_answers_but_keeps_the_saved_snapshot(tmp_path):
    disc = Discover([HACKER])
    hub = make_hub(tmp_path, disc)
    ui = Client()

    async def run():
        hub.clients.add(ui)
        other = await hub._cmd_devices_scan({"bridge_host": "10.0.0.5", "bridge_port": 7070})
        assert other["bridge"]["address"] == "10.0.0.5:7070" and disc.calls[-1]["bridge_port"] == 7070
        assert hub.devices["bridge"]["state"] == "unknown" and not ui.of("devices")
        mine = await hub._cmd_devices_scan({})
        assert mine["devices"][0]["key"] == HACKER["key"] and ui.of("devices")
        with pytest.raises(CommandError, match="адрес моста"):
            await hub._cmd_devices_scan({"bridge_host": "", "bridge_port": 7000})
        await hub.shutdown()
    asyncio.run(run())


def test_device_choice_is_validated_and_saved(tmp_path):
    assert normalize_connection(CONNECT)["device"] == ""
    assert normalize_connection({**CONNECT, "device": "usb:/dev/ttyACM0"})["device"] == "usb:/dev/ttyACM0"
    with pytest.raises(CommandError, match="Неверный прибор"):
        normalize_connection({**CONNECT, "device": "/etc/passwd"})
    hub = make_hub(tmp_path, Discover([HACKER]))

    async def run():
        await hub._cmd_connect({"config": {**CONNECT, "device": HACKER["key"]}})
        await hub.shutdown()
    asyncio.run(run())
    assert JsonStore(tmp_path / "data").load("connection", {})["device"] == HACKER["key"]


def test_saved_bridge_on_the_old_default_port_moves_to_7700(tmp_path):
    # до 21.10.2026 мост слушал 7000 — а там на macOS 12+ отвечает «Приёмник AirPlay»
    JsonStore(tmp_path / "data").save("connection", {**CONNECT, "bridge_host": "host.docker.internal", "bridge_port": 7000})
    hub = make_hub(tmp_path, discover=None)
    assert (hub.connection["bridge_host"], hub.connection["bridge_port"]) == ("host.docker.internal", 7700)


def test_a_bridge_elsewhere_or_on_a_chosen_port_keeps_its_saved_address(tmp_path):
    for i, (host, port) in enumerate([("10.0.0.5", 7000), ("host.docker.internal", 7070)]):
        root = tmp_path / str(i)
        JsonStore(root / "data").save("connection", {**CONNECT, "bridge_host": host, "bridge_port": port})
        hub = make_hub(root, discover=None)
        assert (hub.connection["bridge_host"], hub.connection["bridge_port"]) == (host, port)
    # введённый в «Дополнительно» адрес не переписывается — переезжает только сохранённый старый
    assert normalize_connection({**CONNECT, "bridge_port": 7000})["bridge_port"] == 7000


def test_default_bridge_address_is_port_7700(monkeypatch):
    monkeypatch.delenv("CARBUS_BRIDGE", raising=False)
    cfg = hub_mod.default_connection()
    assert (cfg["bridge_host"], cfg["bridge_port"]) == ("host.docker.internal", 7700)
