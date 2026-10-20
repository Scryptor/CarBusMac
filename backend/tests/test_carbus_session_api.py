"""Контракт адаптера с carbus-lib — проверяется без железа: все методы/поля,
на которые опирается CarbusSession, реально есть в установленной библиотеке."""
from carbus_async import CanMessage, CarBusDevice


def test_carbus_device_has_methods_adapter_uses():
    for m in (
        "open_tcp", "close", "get_device_info", "open_can_channel",
        "send_can", "set_std_id_filter", "set_ext_id_filter",
        "clear_all_filters", "receive_can", "open_can_channel_custom",
        "set_terminator", "clear_can_filter",
    ):
        assert hasattr(CarBusDevice, m), f"CarBusDevice.{m} missing"


def test_can_message_fields_adapter_uses():
    msg = CanMessage(can_id=0x7E0, data=b"\x01", extended=False, rtr=False, fd=False, brs=False)
    assert msg.can_id == 0x7E0
    assert hasattr(msg, "timestamp_us")   # источник метки времени кадра


# --- A8: тайминги, терминатор, слоты фильтров, развёртка 32-битной метки ---
import pytest  # noqa: E402
from carbus_async.device import CanTiming  # noqa: E402

from app.carbus_session import CarbusSession  # noqa: E402


class StubDev:
    """Подмена CarBusDevice: записывает вызовы, отдаёт заранее заданные кадры."""

    def __init__(self, rx=()):
        self.calls = []
        self._rx = list(rx)

    async def open_can_channel(self, **kw):
        self.calls.append(("open", kw))

    async def open_can_channel_custom(self, channel, **kw):
        self.calls.append(("open_custom", channel, kw))

    async def set_terminator(self, channel, enabled):
        self.calls.append(("term", channel, enabled))

    async def clear_can_filter(self, channel, index):
        self.calls.append(("clear", channel, index))

    async def receive_can(self):
        return self._rx.pop(0)


def _session(dev):
    s = CarbusSession("h", 1)
    s._dev = dev
    return s


async def test_frames_unwrap_device_timestamp():
    dev = StubDev(rx=[(1, CanMessage(can_id=1, timestamp_us=0xFFFF_FF00)),
                      (1, CanMessage(can_id=2, timestamp_us=0x0000_0100))])
    it = _session(dev).frames()
    a, b = await anext(it), await anext(it)
    assert b.timestamp - a.timestamp == pytest.approx(512e-6)
    assert a.ts_source == b.ts_source == "device"


async def test_open_channel_with_timing_uses_custom_api():
    dev = StubDev()
    await _session(dev).open_channel(1, None, True, timing={"prescaler": 15, "seg1": 12, "seg2": 3, "sjw": 1})
    assert dev.calls == [("open_custom", 1, {"nominal_timing": CanTiming(15, 12, 3, 1), "listen_only": True})]


async def test_open_channel_with_bitrate_uses_preset_api():
    dev = StubDev()
    await _session(dev).open_channel(2, 500_000, False)
    assert dev.calls == [("open", {"channel": 2, "nominal_bitrate": 500_000, "listen_only": False})]


async def test_set_terminator_and_clear_hw_filter_call_device():
    dev = StubDev()
    s = _session(dev)
    await s.set_terminator(1, True)
    await s.clear_hw_filter(2, 5)
    assert dev.calls == [("term", 1, True), ("clear", 2, 5)]
