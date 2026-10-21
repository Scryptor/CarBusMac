"""Адаптер CanSession поверх carbus-lib — единственное место с настоящим железом.

К прибору два пути (выбор — app/devices.py):
- через нативный мост на маке (app/bridge.py): TCP, приветствие моста, `OPEN <порт>`,
  дальше по тому же сокету — протокол прибора. Docker Desktop на macOS USB в контейнер
  не пробрасывает, поэтому так работает бэкенд в Docker на маке;
- напрямую в USB-порт (`CarbusSession.usb(путь)`): Docker на Linux с пробросом USB или
  бэкенд без Docker.
Транспорт открывает сама сессия и отдаёт потоки библиотеке (`_attach`), дальше всё общее.

Библиотека ждёт ответы прибора без таймаутов, поэтому адаптер их ставит сам: молчащий
мост или прибор не вешает подключение навсегда. Обрыв посреди сессии библиотека не
сообщает (её цикл чтения тихо завершается, а `receive_can()` ждёт вечно) — сессия следит
за этим циклом, и `frames()` бросает ConnectionError.

Кадры забирает из очереди библиотеки своя задача сразу после подключения и ставит им
время прихода: иначе кадры, накопившиеся, пока хаб открывает каналы и ставит фильтры,
получили бы время чтения пачкой, и промежутки между ними пропали бы.

Используются внутренние поля CarBusDevice (`_reader`, `_writer`, `_start_reader`,
`_reader_task`, `_rx_queue` …) — версия библиотеки закреплена в pyproject
(carbus-lib==0.1.9), контракт проверяет tests/test_carbus_session_api.py."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncIterator, Awaitable, Callable, TypeVar

from carbus_async import CanMessage, CarBusDevice
from carbus_async.device import CanTiming

from app.bridge import BridgeDown, BridgeForeign, BridgeRefused, bridge_open, open_serial
from app.devclock import DeviceClock
from app.models import CanFrame

CONNECT_TIMEOUT_S = 5.0     # мост + SYNC + DEVICE_OPEN
COMMAND_TIMEOUT_S = 3.0     # ответ прибора на команду
CLOSE_TIMEOUT_S = 2.0
SYNC = bytes((0xA5, 0x00, 0xA5, 0x00))
SYNC_REPLY = bytes((0x5A, 0x00, 0x5A, 0x00))
SYNC_SKIP_LIMIT = 1 << 20   # столько байт прошлой сессии можно пропустить до ответа на SYNC

T = TypeVar("T")


def _attach(dev: CarBusDevice, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """То же состояние, что ставит CarBusDevice._connect() после открытия транспорта
    (carbus-lib 0.1.9), но на уже открытых потоках."""
    dev._log = logging.getLogger(f"carbus_async.device.{dev.port}")
    dev._wire_log = logging.getLogger(f"carbus_async.wire.{dev.port}")
    dev._reader, dev._writer = reader, writer
    dev._rx_queue = asyncio.Queue()
    dev._rx_channel_queues = {}
    dev._pending = {}
    dev._seq_counter = 0
    dev._reader_task = None
    dev._closed = False
    dev._can_hooks = []
    dev._can_hook_sem = asyncio.Semaphore(200)


async def _sync(dev: CarBusDevice) -> None:
    """SYNC, терпимый к хвосту прошлой сессии: прибор, который бросили без DEVICE_CLOSE
    (выдернули мост, упал процесс), мог оставить каналы открытыми и продолжать слать кадры.
    `CarBusDevice.sync()` принял бы первые 4 байта кадра за ответ и упал."""
    dev._writer.write(SYNC)
    await dev._writer.drain()
    window = b""
    for _ in range(SYNC_SKIP_LIMIT):
        window = (window + await dev._reader.readexactly(1))[-4:]
        if window == SYNC_REPLY:
            return
    raise asyncio.TimeoutError("прибор не ответил на SYNC")     # → «Прибор … не отвечает»


class CarbusSession:
    def __init__(self, host: str | None, port: int | None, device: str = "", *, local: str | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 connect_timeout: float = CONNECT_TIMEOUT_S, command_timeout: float = COMMAND_TIMEOUT_S) -> None:
        """host:port — мост, device — порт прибора на стороне моста ("" — мост выберет
        единственный CAN-Hacker сам); local — порт, открываемый напрямую, без моста."""
        self._host = host
        self._port = port
        self._device = device
        self._local = local
        self._dev: CarBusDevice | None = None
        self._clock = clock
        self._devclock = DeviceClock()
        self._connect_timeout = connect_timeout
        self._command_timeout = command_timeout
        self._rx: asyncio.Queue[CanFrame | Exception] = asyncio.Queue()
        self._pump: asyncio.Task | None = None
        self._stage = "bridge"      # на каком шаге подключения сейчас — для текста ошибки

    @classmethod
    def usb(cls, path: str, **kw) -> CarbusSession:
        return cls(None, None, local=path, **kw)

    # ------------------------------------------------------------ соединение
    def _where(self) -> str:
        return f"{self._host}:{self._port}"

    def _name(self) -> str:
        return self._local or self._device or "CAN-Hacker"

    def _lost(self) -> str:
        if self._local:
            return "связь с прибором потеряна: прибор отключён от USB"
        return "связь с прибором потеряна: прибор отключён от USB или остановлен мост"

    async def connect(self) -> None:
        dev = CarBusDevice(port=self._local or f"bridge://{self._where()}/{self._device or 'auto'}")
        self._stage = "device" if self._local else "bridge"
        try:
            await asyncio.wait_for(self._open(dev), self._connect_timeout)
        except asyncio.TimeoutError:
            self._abort(dev)
            if self._stage == "device":
                raise ConnectionError(f"Прибор {self._name()} не отвечает. Отключите его от USB и подключите "
                                      "снова, затем повторите подключение.") from None
            raise ConnectionError(self._foreign()) from None
        except BridgeDown as e:
            self._abort(dev)
            raise ConnectionError(f"Нет связи с мостом {self._where()} ({e}). "
                                  "Запустите на маке ./run-bridge.sh.") from None
        except BridgeForeign:
            self._abort(dev)
            raise ConnectionError(self._foreign()) from None
        except BridgeRefused as e:
            self._abort(dev)
            raise ConnectionError(f"Мост {self._where()}: {e}") from None
        except (OSError, asyncio.IncompleteReadError, EOFError) as e:
            self._abort(dev)
            if self._local and self._stage == "device" and isinstance(e, OSError):
                raise ConnectionError(f"Не удалось открыть {self._local}: {e}") from None
            raise ConnectionError(f"Прибор {self._name()} закрыл соединение при подключении. "
                                  "Отключите его от USB и подключите снова.") from None
        except BaseException:
            self._abort(dev)
            raise
        self._dev = dev
        self._start_pump()

    def _foreign(self) -> str:
        return (f"Мост {self._where()} не отвечает: по этому адресу слушает не мост CarBUS. Запустите или "
                "перезапустите на маке ./run-bridge.sh (без моста порт 7000 на macOS занимает «Приёмник "
                "AirPlay» — Системные настройки → Основные → AirDrop и Handoff).")

    async def _open(self, dev: CarBusDevice) -> None:
        # то же, что CarBusDevice.open(), но транспорт свой и объект доступен при сбое
        if self._local:
            reader, writer = await open_serial(self._local)
        else:
            reader, writer, _ = await bridge_open(self._host, self._port, self._device, self._connect_timeout)
            self._stage = "device"
        _attach(dev, reader, writer)
        await _sync(dev)
        dev._start_reader()
        await dev.device_open(use_can=True, use_lin=False)

    @staticmethod
    def _abort(dev: CarBusDevice) -> None:
        """Бросить полуоткрытое соединение без обмена с прибором (он может не отвечать)."""
        task = getattr(dev, "_reader_task", None)
        if task is not None:
            task.cancel()
        writer = getattr(dev, "_writer", None)
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        try:
            dev._closed = True
        except Exception:
            pass

    async def close(self) -> None:
        dev, self._dev = self._dev, None
        if self._pump is not None:
            self._pump.cancel()
            self._pump = None
        if dev is None:
            return
        try:
            await asyncio.wait_for(dev.close(), CLOSE_TIMEOUT_S)
        except Exception:
            pass
        finally:
            # и после штатного закрытия: библиотека, сама пометившая себя закрытой (обрыв
            # моста), выходит из close() сразу и оставляет сокет открытым; при отмене — тоже
            self._abort(dev)

    def _require(self) -> CarBusDevice:
        if self._dev is None:
            raise ConnectionError("Нет подключения к прибору")
        return self._dev

    async def _call(self, aw: Awaitable[T]) -> T:
        try:
            return await asyncio.wait_for(aw, self._command_timeout)
        except asyncio.TimeoutError:
            raise TimeoutError("Прибор не ответил вовремя") from None

    # --------------------------------------------------------------- команды
    async def get_device_info(self) -> dict:
        info = await self._call(self._require().get_device_info())
        return {
            "hardware_name": info.hardware_name,
            "hardware_id": info.hardware_id,
            "firmware_version": info.firmware_version,
            "serial_int": info.serial_int,
            "features_mask": info.features_mask,
            "feature_gateway": info.feature_gateway,
            "feature_isotp": info.feature_isotp,
            "feature_tx_buffer": info.feature_tx_buffer,
            "feature_tx_task": info.feature_tx_task,
            "channel_types": info.channel_types,
            "channel_features": info.channel_features,
            "channel_frequencies": info.channel_frequencies,
            "filters_info": info.filters_info,
        }

    async def open_channel(
        self, channel: int, bitrate: int | None, listen_only: bool, timing: dict | None = None
    ) -> None:
        dev = self._require()
        if timing is not None:
            await self._call(dev.open_can_channel_custom(
                channel,
                nominal_timing=CanTiming(
                    int(timing["prescaler"]), int(timing["seg1"]), int(timing["seg2"]), int(timing["sjw"])
                ),
                listen_only=listen_only,
            ))
            return
        await self._call(dev.open_can_channel(channel=channel, nominal_bitrate=bitrate, listen_only=listen_only))

    async def set_terminator(self, channel: int, enabled: bool) -> None:
        await self._call(self._require().set_terminator(channel, enabled))

    async def clear_hw_filter(self, channel: int, index: int) -> None:
        await self._call(self._require().clear_can_filter(channel, index))

    async def send(self, frame: CanFrame) -> None:
        # у RTR данных нет, но DLC у кадра есть: библиотека берёт DLC из длины данных,
        # поэтому для RTR кладём DLC нулевых байт (CanFrame хранит их так же)
        msg = CanMessage(
            can_id=frame.can_id,
            data=frame.data,
            extended=frame.extended,
            rtr=frame.rtr,
            fd=frame.fd,
            brs=frame.brs,
        )
        await self._call(self._require().send_can(msg, channel=frame.channel))

    async def set_hw_filter(
        self, channel: int, index: int, can_id: int, mask: int, extended: bool
    ) -> None:
        dev = self._require()
        if extended:
            await self._call(dev.set_ext_id_filter(channel, index, can_id, mask))
        else:
            await self._call(dev.set_std_id_filter(channel, index, can_id, mask))

    async def clear_filters(self, channel: int) -> None:
        await self._call(self._require().clear_all_filters(channel))

    # ----------------------------------------------------------------- приём
    def _frame(self, channel: int, msg: CanMessage) -> CanFrame:
        now = self._clock()
        if msg.timestamp_us:
            ts, src = self._devclock.to_host(msg.timestamp_us, now), "device"
        else:
            ts, src = now, "arrival"
        return CanFrame(
            channel=channel,
            can_id=msg.can_id,
            data=bytes(msg.data),
            extended=msg.extended,
            rtr=msg.rtr,
            fd=msg.fd,
            brs=msg.brs,
            timestamp=ts,
            ts_source=src,
        )

    def _start_pump(self) -> None:
        if self._pump is None and self._dev is not None:
            self._pump = asyncio.create_task(self._pump_rx(self._dev))

    async def _pump_rx(self, dev: CarBusDevice) -> None:
        """Забирает кадры из очереди библиотеки по мере прихода и ставит им время."""
        try:
            queue = getattr(dev, "_rx_queue", None)
            reader = getattr(dev, "_reader_task", None)
            if queue is None or reader is None:     # чужой объект (тесты) — без слежения за обрывом
                while True:
                    channel, msg = await dev.receive_can()
                    self._rx.put_nowait(self._frame(channel, msg))
            while True:
                try:
                    channel, msg = queue.get_nowait()
                except asyncio.QueueEmpty:
                    if reader.done():
                        raise ConnectionError(self._lost()) from None
                    get = asyncio.ensure_future(queue.get())
                    try:
                        await asyncio.wait({get, reader}, return_when=asyncio.FIRST_COMPLETED)
                    except BaseException:
                        get.cancel()
                        raise
                    if not get.done():
                        get.cancel()
                        continue                 # цикл чтения кончился: дочитать очередь и сообщить
                    channel, msg = get.result()
                self._rx.put_nowait(self._frame(channel, msg))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._rx.put_nowait(e)

    async def frames(self) -> AsyncIterator[CanFrame]:
        self._require()
        self._start_pump()
        while True:
            item = await self._rx.get()
            if isinstance(item, Exception):
                raise item
            yield item
