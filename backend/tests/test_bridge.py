"""Мост (app/bridge.py) и подключение через него — без железа: «последовательный порт»
моста здесь — TCP до поддельного прибора, говорящего минимум протокола CAN-Hacker."""
import asyncio

import pytest

from app import bridge as bridge_mod
from app.bridge import Bridge, BridgeDown, BridgeForeign, BridgeRefused, bridge_list, bridge_open
from app.carbus_session import CarbusSession
from app.usbports import describe

HACKER_PATH = "/dev/cu.usbmodem00000000001A1"
LG_PATH = "/dev/cu.usbmodem506NTBKGE1012"
HACKER = describe(HACKER_PATH, product="CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201",
                  manufacturer="Spectratek", vid=0x0483, pid=0x5740, serial_number="00000000001A")
LG = describe(LG_PATH, product="LG Monitor Controls", manufacturer="LG Electronics Inc.", vid=0x043E, pid=0x9A39)
# DEVICE_INFO настоящего прибора (HW_CH32, 2.2.3.57, № 6950)
INFO = bytes.fromhex("01000001 00000282 322e322e 332e3537 00000283 00000000 00001b26 01000011"
                     "01011012 09000113 01000213 0e060114 0e060214 08010314 20020115 20010215")


class FakeDevice:
    """Минимальный CAN-Hacker: SYNC, DEVICE_OPEN/CLOSE, DEVICE_INFO."""

    def __init__(self, tail: bytes = b""):
        self.tail = tail                 # хвост прошлой сессии перед ответом на SYNC
        self.writers: list[asyncio.StreamWriter] = []

    async def handle(self, reader, writer):
        self.writers.append(writer)
        try:
            while True:
                b = await reader.readexactly(1)
                if b[0] == 0xA5:
                    await reader.readexactly(3)
                    writer.write(self.tail + bytes((0x5A, 0, 0x5A, 0)))
                    continue
                cmd, seq, _flags, dsize = b + await reader.readexactly(3)
                if dsize:
                    await reader.readexactly(dsize)
                if cmd == 0x06:
                    writer.write(bytes((0x06, seq, 0, len(INFO))) + INFO)
                elif cmd in (0x08, 0x09, 0x18):
                    writer.write(bytes((cmd | 0x80, seq, 0, 0)))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()


class Rig:
    """Поддельный прибор + настоящий мост, чей «порт» — TCP до прибора."""

    def __init__(self, ports, forced=None, tail=b""):
        self.device = FakeDevice(tail)
        self.ports = ports
        self.opened: list[str] = []
        self.forced = forced

    async def __aenter__(self):
        self.dev_srv = await asyncio.start_server(self.device.handle, "127.0.0.1", 0)
        dev_port = self.dev_srv.sockets[0].getsockname()[1]

        async def opener(path):
            self.opened.append(path)
            return await asyncio.open_connection("127.0.0.1", dev_port)

        self.bridge = Bridge(self.forced, scan=lambda: [dict(p) for p in self.ports], opener=opener)
        self.srv = await asyncio.start_server(self.bridge.handle, "127.0.0.1", 0)
        self.port = self.srv.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        for s in (self.srv, self.dev_srv):
            s.close()
            await s.wait_closed()


async def _until(pred, timeout=2.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        assert loop.time() < end, "условие не наступило"
        await asyncio.sleep(0.01)


async def test_list_returns_usb_ports_with_kinds_and_busy_flags():
    async with Rig([HACKER, LG]) as rig:
        ports = await bridge_list("127.0.0.1", rig.port)
    assert [(p["path"], p["kind"], p["busy"]) for p in ports] == [
        (HACKER_PATH, "canhacker", False), (LG_PATH, "other", False)]
    assert rig.opened == []                          # перечисление портов их не открывает


async def test_session_connects_through_bridge_and_frees_port_on_close():
    async with Rig([HACKER, LG]) as rig:
        s = CarbusSession("127.0.0.1", rig.port)     # прибор не задан — мост выберет CAN-Hacker сам
        await s.connect()
        try:
            assert (await s.get_device_info())["hardware_name"] == "HW_CH32"
            assert rig.opened == [HACKER_PATH]
            ports = await bridge_list("127.0.0.1", rig.port)
            assert [p["busy"] for p in ports] == [True, False]
        finally:
            await s.close()
        await _until(lambda: not rig.bridge.busy)


async def test_bridge_never_opens_a_port_that_is_not_a_canhacker():
    async with Rig([HACKER, LG]) as rig:
        with pytest.raises(BridgeRefused, match="не CAN-Hacker"):
            await bridge_open("127.0.0.1", rig.port, LG_PATH)
        with pytest.raises(BridgeRefused, match="не найден"):
            await bridge_open("127.0.0.1", rig.port, "/dev/cu.usbmodemGONE")
        assert rig.opened == []


async def test_auto_needs_exactly_one_device_unless_a_port_is_forced():
    other = {**HACKER, "path": "/dev/cu.usbmodem2"}
    async with Rig([HACKER, other]) as rig:
        with pytest.raises(BridgeRefused, match="несколько"):
            await bridge_open("127.0.0.1", rig.port, "")
    async with Rig([LG]) as rig:
        with pytest.raises(BridgeRefused, match="не найден"):
            await bridge_open("127.0.0.1", rig.port, "auto")
    async with Rig([LG], forced=LG_PATH) as rig:      # CARBUS_SERIAL: «это прибор, открывай»
        ports = await bridge_list("127.0.0.1", rig.port)
        assert ports[0]["forced"] is True
        _, writer, info = await bridge_open("127.0.0.1", rig.port, "auto")
        writer.close()
        assert info["path"] == LG_PATH and rig.opened == [LG_PATH]


async def test_old_style_client_that_speaks_first_gets_the_device_directly():
    async with Rig([HACKER]) as rig:
        reader, writer = await asyncio.open_connection("127.0.0.1", rig.port)
        writer.write(bytes((0xA5, 0, 0xA5, 0)))          # как CarBusDevice.open_tcp: сразу SYNC
        await writer.drain()
        assert await asyncio.wait_for(reader.readexactly(4), 2) == bytes((0x5A, 0, 0x5A, 0))
        writer.close()
        assert rig.opened == [HACKER_PATH]


async def test_second_open_of_a_busy_port_waits_then_refuses(monkeypatch):
    monkeypatch.setattr(bridge_mod, "BUSY_WAIT_S", 0.2)
    async with Rig([HACKER]) as rig:
        _, w1, _ = await bridge_open("127.0.0.1", rig.port, HACKER_PATH)
        try:
            with pytest.raises(BridgeRefused, match="уже открыт"):
                await bridge_open("127.0.0.1", rig.port, HACKER_PATH)
        finally:
            w1.close()
        await _until(lambda: not rig.bridge.busy)
        _, w2, _ = await bridge_open("127.0.0.1", rig.port, HACKER_PATH)   # порт освободился
        w2.close()


async def test_client_tells_a_stranger_from_an_absent_bridge():
    async def silent(reader, writer):            # принимает и молчит — как чужая программа на порту моста
        await reader.read()
        writer.close()

    srv = await asyncio.start_server(silent, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    try:
        with pytest.raises(BridgeForeign):
            await bridge_list("127.0.0.1", port, timeout=0.3)
    finally:
        srv.close()
        await srv.wait_closed()
    with pytest.raises(BridgeDown):
        await bridge_list("127.0.0.1", port, timeout=0.3)


async def test_session_survives_frames_left_by_a_previous_session():
    tail = bytes.fromhex("40 05 00 20 17 00 00 00 00 10 58 cf 53 02 00 00 00 00 23 01")
    async with Rig([HACKER], tail=tail) as rig:
        s = CarbusSession("127.0.0.1", rig.port, HACKER_PATH)
        await s.connect()
        assert (await s.get_device_info())["serial_int"] == 6950
        await s.close()


async def test_session_errors_name_the_reason():
    async with Rig([HACKER]) as rig:
        with pytest.raises(ConnectionError, match="Порт /dev/cu.usbmodemX не найден"):
            await CarbusSession("127.0.0.1", rig.port, "/dev/cu.usbmodemX").connect()


async def test_unplugged_device_ends_frames_with_a_clear_error():
    async with Rig([HACKER]) as rig:
        s = CarbusSession("127.0.0.1", rig.port)
        await s.connect()
        rig.device.writers[-1].close()                  # прибор выдернули: «порт» моста закрылся
        with pytest.raises(ConnectionError, match="отключён от USB или остановлен мост"):
            await asyncio.wait_for(anext(s.frames()), 2)
        await s.close()


async def test_usb_session_opens_the_port_itself(monkeypatch):
    dev = FakeDevice()
    srv = await asyncio.start_server(dev.handle, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    opened = []

    async def fake_serial(path):
        opened.append(path)
        return await asyncio.open_connection("127.0.0.1", port)

    import app.carbus_session as cs
    monkeypatch.setattr(cs, "open_serial", fake_serial)
    try:
        s = CarbusSession.usb("/dev/ttyACM0")
        await s.connect()
        assert (await s.get_device_info())["hardware_name"] == "HW_CH32" and opened == ["/dev/ttyACM0"]
        dev.writers[-1].close()
        with pytest.raises(ConnectionError, match="прибор отключён от USB$"):
            await asyncio.wait_for(anext(s.frames()), 2)
        await s.close()
    finally:
        srv.close()
        await srv.wait_closed()


def test_the_bridge_listens_on_loopback_port_7700_by_default(monkeypatch):
    seen = []

    async def serve(host, port, serial):
        seen.append((host, port, serial))
    monkeypatch.setattr(bridge_mod, "serve", serve)
    monkeypatch.delenv("CARBUS_SERIAL", raising=False)
    assert bridge_mod.main([]) == 0
    assert seen == [("127.0.0.1", 7700, None)]
