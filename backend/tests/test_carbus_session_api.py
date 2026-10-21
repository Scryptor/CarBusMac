"""Контракт адаптера с carbus-lib — проверяется без железа: все методы/поля,
на которые опирается CarbusSession, реально есть в установленной библиотеке."""
from carbus_async import CanMessage, CarBusDevice


def test_carbus_device_has_methods_adapter_uses():
    for m in (
        "open_tcp", "close", "get_device_info", "open_can_channel",
        "send_can", "set_std_id_filter", "set_ext_id_filter",
        "clear_all_filters", "receive_can", "open_can_channel_custom",
        "set_terminator", "clear_can_filter",
        # внутренние, на которые опирается адаптер (свой транспорт, таймауты, слежение за обрывом)
        "_connect", "_start_reader", "device_open",
    ):
        assert hasattr(CarBusDevice, m), f"CarBusDevice.{m} missing"
    fields = CarBusDevice.__dataclass_fields__
    for f in ("port", "_reader", "_writer", "_reader_task", "_rx_queue", "_closed"):
        assert f in fields, f"CarBusDevice.{f} missing"


async def test_attach_sets_the_same_state_as_library_connect():
    """_attach повторяет то, что CarBusDevice._connect() ставит после открытия транспорта:
    новое поле в библиотеке — и этот тест покажет, что адаптер его не знает."""
    import asyncio

    from app.carbus_session import _attach

    accepted = []
    srv = await asyncio.start_server(lambda r, w: accepted.append(w), "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    try:
        lib = CarBusDevice(port=f"socket://127.0.0.1:{port}")
        before = set(vars(lib))
        await lib._connect()
        lib_set = set(vars(lib)) - before
        lib._writer.close()
        ours = CarBusDevice(port="x")
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        _attach(ours, reader, writer)
        writer.close()
        assert set(vars(ours)) - before == lib_set
    finally:
        await asyncio.sleep(0.01)                   # сервер принимает оба соединения — закрыть и их
        for w in accepted:
            w.close()
        srv.close()
        await srv.wait_closed()


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


def _session_at(dev, *times):
    s = CarbusSession("h", 1, clock=iter(times).__next__)
    s._dev = dev
    return s


async def test_frames_unwrap_device_timestamp():
    dev = StubDev(rx=[(1, CanMessage(can_id=1, timestamp_us=0xFFFF_FF00)),
                      (1, CanMessage(can_id=2, timestamp_us=0x0000_0100))])
    it = _session_at(dev, 100.0, 100.000512).frames()   # кадры приходят в реальном времени
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


# --- обрыв моста, таймауты подключения и команд ---
import asyncio  # noqa: E402


class LoopDev:
    """Как CarBusDevice изнутри: очередь приёма и задача цикла чтения."""

    def __init__(self):
        self._rx_queue = asyncio.Queue()
        self._done = asyncio.Event()
        self._reader_task = asyncio.ensure_future(self._done.wait())


async def test_frames_report_bridge_drop_after_draining_queue():
    dev = LoopDev()
    s = CarbusSession("h", 1)
    s._dev = dev
    dev._rx_queue.put_nowait((1, CanMessage(can_id=0x100, timestamp_us=1000)))
    it = s.frames()
    assert (await anext(it)).can_id == 0x100
    dev._rx_queue.put_nowait((1, CanMessage(can_id=0x101, timestamp_us=2000)))
    dev._done.set()                                   # мост закрыл соединение
    assert (await anext(it)).can_id == 0x101          # уже принятое не теряется
    with pytest.raises(ConnectionError):
        await asyncio.wait_for(anext(it), 1)


async def test_connect_to_silent_bridge_times_out_and_closes_socket():
    closed = asyncio.Event()

    async def handle(reader, writer):
        while await reader.read(64):                  # принимает, но не отвечает (как AirPlay на :7000)
            pass
        closed.set()
        writer.close()

    srv = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    try:
        s = CarbusSession("127.0.0.1", port, connect_timeout=0.3)
        with pytest.raises(ConnectionError, match="не отвечает"):
            await s.connect()
        await asyncio.wait_for(closed.wait(), 2)      # полуоткрытое соединение закрыто
    finally:
        srv.close()
        await srv.wait_closed()


async def test_connect_to_closed_port_is_a_clear_error():
    srv = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    srv.close()
    await srv.wait_closed()
    with pytest.raises(ConnectionError, match="Нет связи с мостом"):
        await CarbusSession("127.0.0.1", port, connect_timeout=1).connect()


async def test_device_command_times_out():
    class Silent(StubDev):
        async def set_terminator(self, channel, enabled):
            await asyncio.sleep(10)

    s = CarbusSession("h", 1, command_timeout=0.05)
    s._dev = Silent()
    with pytest.raises(TimeoutError, match="не ответил"):
        await s.set_terminator(1, True)


async def test_frames_get_arrival_time_even_when_read_later():
    """Кадры, пришедшие, пока хаб открывал каналы, читаются потом пачкой — но время у них
    должно остаться временем прихода (промежутки по прибору не схлопываются)."""
    now = [10.0]
    dev = LoopDev()
    s = CarbusSession("h", 1, clock=lambda: now[0])
    s._dev = dev
    s._start_pump()
    for k in range(4):                                # кадры через 0,5 мс, приходят в реальном времени
        now[0] = 10.001 + k * 0.0005
        dev._rx_queue.put_nowait((1, CanMessage(can_id=0x100 + k, timestamp_us=1000 + k * 500)))
        await asyncio.sleep(0)
    now[0] = 10.5                                     # хаб начал читать только сейчас
    it = s.frames()
    ts = [(await anext(it)).timestamp for _ in range(4)]
    assert [round(b - a, 6) for a, b in zip(ts, ts[1:])] == [0.0005, 0.0005, 0.0005]
    await s.close()


async def test_close_shuts_socket_even_if_library_already_marked_itself_closed():
    class Writer:
        closed = False

        def close(self):
            self.closed = True

    class Dropped:
        """Библиотека после обрыва моста: _closed=True, close() выходит сразу."""
        _reader_task = None

        def __init__(self):
            self._writer = Writer()

        async def close(self):
            return None

    dev = Dropped()
    s = CarbusSession("h", 1)
    s._dev = dev
    await s.close()
    assert dev._writer.closed
