"""Распознавание CAN-Hacker по USB-описателям (без открытия портов)."""
from types import SimpleNamespace

from app import usbports
from app.usbports import describe, label

HACKER = "CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201"     # так прибор виден на маке


def test_canhacker_product_string_gives_model_serial_and_firmware():
    d = describe("/dev/cu.usbmodem00000000001A1", product=HACKER, manufacturer="Spectratek",
                 description=HACKER, vid=0x0483, pid=0x5740, serial_number="00000000001A")
    assert d["kind"] == "canhacker"
    assert (d["title"], d["serial"], d["firmware"]) == ("CAN-Hacker v3.2", 6950, "2.2.3.57")
    assert d["usb_serial"] == "00000000001A"
    assert label(d) == "CAN-Hacker v3.2 № 6950 (/dev/cu.usbmodem00000000001A1)"


def test_other_usb_ports_are_not_mistaken_for_the_device():
    lg = describe("/dev/cu.usbmodem506NTBKGE1012", product="LG Monitor Controls",
                  manufacturer="LG Electronics Inc.", vid=0x043E, pid=0x9A39)
    assert lg["kind"] == "other" and lg["title"] == "LG Monitor Controls" and lg["serial"] is None
    # VID:PID «виртуального COM-порта» STM32 без имени — лишь «совместимый»
    vcp = describe("/dev/ttyACM0", product="STM32 Virtual ComPort", vid=0x0483, pid=0x5740)
    assert vcp["kind"] == "compatible" and vcp["firmware"] is None
    # имя прибора без серийного/прошивки в строке — всё равно CAN-Hacker, заголовок как есть
    plain = describe("/dev/ttyACM1", product="CAN_Hacker", vid=0x1234, pid=0x0001)
    assert plain["kind"] == "canhacker" and plain["title"] == "CAN_Hacker" and plain["serial"] is None
    # без описателей — заголовок по имени порта; «n/a» pyserial — не текст
    bare = describe("/dev/ttyUSB3", description="n/a")
    assert bare["title"] == "ttyUSB3" and bare["product"] is None and bare["kind"] == "other"


def test_scan_skips_non_usb_ports_and_puts_the_device_first(monkeypatch):
    def port(device, **kw):
        base = dict(vid=None, pid=None, product=None, manufacturer=None, description="n/a", serial_number=None)
        return SimpleNamespace(device=device, **{**base, **kw})

    fake = [
        port("/dev/cu.Bluetooth-Incoming-Port"),
        port("/dev/cu.usbmodem506NTBKGE1012", vid=0x043E, pid=0x9A39, product="LG Monitor Controls"),
        port("/dev/cu.usbmodem00000000001A1", vid=0x0483, pid=0x5740, product=HACKER, manufacturer="Spectratek"),
    ]
    import serial.tools.list_ports as lp
    monkeypatch.setattr(lp, "comports", lambda: fake)
    found = usbports.scan_ports()
    assert [d["path"] for d in found] == ["/dev/cu.usbmodem00000000001A1", "/dev/cu.usbmodem506NTBKGE1012"]
    assert [d["kind"] for d in found] == ["canhacker", "other"]


def test_port_passed_into_a_container_without_usb_info_is_still_offered(monkeypatch):
    bare = SimpleNamespace(device="/dev/ttyACM0", vid=None, pid=None, product=None, manufacturer=None,
                           description="n/a", serial_number=None)
    console = SimpleNamespace(**{**vars(bare), "device": "/dev/ttyS0"})
    import serial.tools.list_ports as lp
    monkeypatch.setattr(lp, "comports", lambda: [bare, console])
    assert usbports.scan_ports() == []                       # на маке порты без USB — не приборы
    found = usbports.scan_ports(passthrough=True)            # в контейнере: проброшен в compose
    assert [(d["path"], d["kind"], d["title"]) for d in found] == [
        ("/dev/ttyACM0", "compatible", "USB-порт ttyACM0")]
