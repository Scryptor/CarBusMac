"""Снимок приборов (свой USB + мост) и выбор прибора для подключения."""
import pytest

from app.bridge import BridgeDown, BridgeForeign
from app.devices import DeviceError, discover, pick
from app.usbports import describe

CFG = {"bridge_host": "host.docker.internal", "bridge_port": 7000}
HACKER = describe("/dev/cu.usbmodem00000000001A1", product="CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201",
                  manufacturer="Spectratek", vid=0x0483, pid=0x5740, serial_number="00000000001A")
LG = describe("/dev/cu.usbmodem506NTBKGE1012", product="LG Monitor Controls", vid=0x043E, pid=0x9A39)
ACM = describe("/dev/ttyACM0", product="CAN-Hacker v3.2 0000000000000ABC 2.2.3.57 A0", vid=0x0483, pid=0x5740)


def listing(ports=None, exc=None):
    async def fn(host, port, timeout):
        assert (host, port) == ("host.docker.internal", 7000)
        if exc:
            raise exc
        return [{**p, "busy": False, "forced": False} for p in ports or []]
    return fn


async def test_mac_docker_sees_the_device_through_the_bridge_only():
    snap = await discover(CFG, scan=lambda: [], listing=listing([HACKER, LG]), container=True)
    assert [(d["key"], d["selectable"]) for d in snap["devices"]] == [
        ("bridge:/dev/cu.usbmodem00000000001A1", True), ("bridge:/dev/cu.usbmodem506NTBKGE1012", False)]
    assert snap["bridge"] == {"state": "ok", "address": "host.docker.internal:7000", "message": ""}
    assert snap["usb"] == {"state": "ok", "in_container": True} and snap["hint"] == ""
    assert pick(snap, "")["path"] == "/dev/cu.usbmodem00000000001A1"


async def test_same_device_seen_twice_is_listed_once_via_direct_usb():
    snap = await discover(CFG, scan=lambda: [HACKER], listing=listing([HACKER]), container=False)
    assert [d["key"] for d in snap["devices"]] == ["usb:/dev/cu.usbmodem00000000001A1"]


async def test_hint_explains_why_nothing_was_found():
    down = await discover(CFG, scan=lambda: [], listing=listing(exc=BridgeDown("соединение отклонено")))
    assert down["bridge"]["state"] == "down" and "./run-bridge.sh" in down["hint"]
    foreign = await discover(CFG, scan=lambda: [], listing=listing(exc=BridgeForeign("нет приветствия")))
    assert foreign["bridge"]["state"] == "foreign" and "AirPlay" in foreign["hint"]
    empty = await discover(CFG, scan=lambda: [LG], listing=listing([]))
    assert empty["hint"] == "Мост работает, но CAN-Hacker не подключён по USB."
    with pytest.raises(DeviceError, match="не подключён по USB"):
        pick(empty, "")


async def test_linux_container_with_usb_passthrough_needs_no_bridge():
    snap = await discover(CFG, scan=lambda: [ACM], listing=listing(exc=BridgeDown("соединение отклонено")),
                          container=True)
    assert snap["hint"] == "" and pick(snap, "")["key"] == "usb:/dev/ttyACM0"


async def test_broken_usb_enumeration_still_leaves_the_bridge():
    def boom():
        raise OSError("no sysfs")
    snap = await discover(CFG, scan=boom, listing=listing([HACKER]))
    assert snap["usb"]["state"] == "unavailable" and len(snap["devices"]) == 1


async def test_pick_by_key_and_its_fallbacks():
    snap = await discover(CFG, scan=lambda: [ACM], listing=listing([HACKER, LG]))
    assert pick(snap, "bridge:/dev/cu.usbmodem00000000001A1")["source"] == "bridge"
    with pytest.raises(DeviceError, match="несколько"):
        pick(snap, "")                                  # два CAN-Hacker — без выбора не подключаемся
    with pytest.raises(DeviceError, match="не CAN-Hacker"):
        pick(snap, "bridge:/dev/cu.usbmodem506NTBKGE1012")
    with pytest.raises(DeviceError, match="не найден"):
        pick(snap, "bridge:/dev/cu.usbmodemGONE")
    # тот же порт, но теперь виден другим путём (был мост, стал проброс в контейнер)
    assert pick(snap, "bridge:/dev/ttyACM0")["key"] == "usb:/dev/ttyACM0"


async def test_bridge_entries_are_sanitised():
    weird = {"path": "/dev/x", "kind": "evil", "title": 5, "serial": "1", "vid": True, "busy": 1}
    snap = await discover(CFG, scan=lambda: [], listing=listing([weird]))
    d = snap["devices"][0]
    assert (d["kind"], d["title"], d["serial"], d["vid"], d["selectable"]) == ("other", "x", None, None, False)
