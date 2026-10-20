"""Контракт адаптера с carbus-lib — проверяется без железа: все методы/поля,
на которые опирается CarbusSession, реально есть в установленной библиотеке."""
from carbus_async import CanMessage, CarBusDevice


def test_carbus_device_has_methods_adapter_uses():
    for m in (
        "open_tcp", "close", "get_device_info", "open_can_channel",
        "send_can", "set_std_id_filter", "set_ext_id_filter",
        "clear_all_filters", "receive_can",
    ):
        assert hasattr(CarBusDevice, m), f"CarBusDevice.{m} missing"


def test_can_message_fields_adapter_uses():
    msg = CanMessage(can_id=0x7E0, data=b"\x01", extended=False, rtr=False, fd=False, brs=False)
    assert msg.can_id == 0x7E0
    assert hasattr(msg, "timestamp_us")   # источник метки времени кадра
