"""Одно состояние приложения на процесс бэкенда (аналог главного окна десктопа).

К хабу подключаются WebSocket-клиенты; перезагрузка страницы не рвёт ни
подключение к прибору, ни запись потока, ни передачу — новый клиент получает
снапшот `hello`. Команды клиента: `{type, req_id?, ...}`; ответ —
`{type: "reply", req_id, ok, data | error}`; без req_id ошибка уходит событием `error`.

Конвейер приёма: кадр → программные фильтры → монитор → поток → фоновый лог →
триггеры передачи → отладчик («остановить при получении данных»). Кадры, которые
мы шлём (передача и отладчик), попадают в поток с направлением Tx."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol
from zoneinfo import ZoneInfo

from app.can_session import CanSession
from app.capture import Capture, copy_markers
from app.deskfmt import format_cmt, format_tsk, parse_cmt, parse_tsk
from app.devices import empty_snapshot, pick
from app.filters import HwFilters, SoftFilters, layout_from_device, layout_kinds, range_from_dict, slot_from_dict
from app.logger import StreamLogger, trc_meta
from app.models import CanFrame
from app.monitor import MonitorState
from app.schemas import row_to_dict
from app.settings import DEFAULT_SETTINGS, merge_settings
from app.store import JsonStore
from app.tracefmt import TraceDoc, atomic_text, clean_text, read_trace, write_trace
from app.tracer import PlayerConfig, TracePlayer, TracerDoc, TraceRow, trace_doc_from_rows
from app.transmit import TransmitManager, skipped_text, task_from_dict

TICK_SECONDS = 0.04
DEFAULT_CLOCK_HZ = 120_000_000   # тактовая CAN у CH32, если прибор её не сообщил
PRESET_BITRATES = (10000, 20000, 33300, 50000, 62500, 83300, 95200, 100000, 125000, 250000,
                   400000, 500000, 800000, 1000000)
# Долгие команды выполняются в фоне: сокет вкладки не ждёт их и принимает следующие
# (например «Отключиться», пока висит подключение к молчащему мосту).
BACKGROUND_COMMANDS = frozenset({"connect", "capture_save", "capture_load", "capture_to_tracer",
                                 "tracer_open", "tracer_save", "devices_scan", "capture_frames"})
DEVICE_POLL_S = 2.0              # как часто искать прибор на USB, пока открыт интерфейс
_DEVICE_KEY_RE = re.compile(r"^(bridge|usb|demo):")
TRACE_EXT = (".trc", ".jsonl")
LIST_EXT = (".json", ".cmt", ".tsk")
COMMENT_EXT = (".cmt", ".json")
TASK_EXT = (".tsk", ".json")
FILTER_EXT = (".json",)
_NAME_RE = re.compile(r"^[^/\\\x00-\x1f]+$")
MAX_ROWS_PER_REQUEST = 2000


class Client(Protocol):
    def send(self, msg: dict) -> None: ...


class CommandError(ValueError):
    pass


def parse_message(raw: str | dict) -> dict:
    msg = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(msg, dict):
        raise CommandError("message needs a 'type'")
    return msg


def finite(v: Any) -> float:
    """float из входных данных: строки «NaN»/«Infinity» тоже не пропускаем."""
    x = float(v)
    if not math.isfinite(x):
        raise CommandError("недопустимое число")
    return x


def all_finite(v: Any) -> bool:
    """NaN/Infinity в команде не принимаем: такое число, попав в состояние, сломало бы
    JSON.parse у всех вкладок (браузер их не понимает)."""
    if isinstance(v, float):
        return math.isfinite(v)
    if isinstance(v, dict):
        return all(all_finite(x) for x in v.values())
    if isinstance(v, list):
        return all(all_finite(x) for x in v)
    return True


def safe_name(name: str, allowed: tuple[str, ...], default_ext: str | None = None) -> str:
    """Только basename без скрытых файлов и с разрешённым расширением. При сохранении
    (`default_ext`) имя без подходящего расширения его получает: «поездка 20.10.2026» →
    «поездка 20.10.2026.trc»."""
    name = str(name or "").strip()
    if default_ext and Path(name).suffix.lower() not in allowed:
        name += default_ext
    if (not name or name != Path(name).name or name.startswith(".") or not _NAME_RE.match(name)
            or Path(name).suffix.lower() not in allowed):
        raise CommandError(f"Недопустимое имя файла: {name}")
    return name


def default_connection() -> dict[str, Any]:
    target = os.environ.get("CARBUS_BRIDGE", "host.docker.internal:7000")
    host, _, port = target.partition(":")
    return {
        "bridge_host": host or "host.docker.internal",
        "bridge_port": int(port or 7000),
        "device": "",
        "channels": [_channel_default(1), _channel_default(2)],
    }


def _channel_default(n: int) -> dict[str, Any]:
    return {"channel": n, "alias": "", "bitrate": 500000, "timing": None, "listen_only": False,
            "terminator": False, "auto_open": n == 1}


def normalize_connection(cfg: dict[str, Any]) -> dict[str, Any]:
    out = {"bridge_host": str(cfg.get("bridge_host") or "").strip(),
           "bridge_port": int(cfg.get("bridge_port") or 0),
           # прибор из «Настроек устройства» ("" — единственный найденный CAN-Hacker)
           "device": str(cfg.get("device") or "").strip(), "channels": []}
    if not out["bridge_host"] or not 0 < out["bridge_port"] < 65536:
        raise CommandError("Неверный адрес моста")
    if out["device"] and (len(out["device"]) > 512 or not _DEVICE_KEY_RE.match(out["device"])):
        raise CommandError("Неверный прибор")
    by_ch = {int(c.get("channel", 0)): c for c in cfg.get("channels") or []}
    for n in (1, 2):
        c = {**_channel_default(n), **by_ch.get(n, {})}
        timing = c.get("timing")
        if timing is not None:
            timing = {k: int(timing[k]) for k in ("prescaler", "seg1", "seg2", "sjw")}
            if not all(v > 0 for v in timing.values()):
                raise CommandError("Неверный тайминг канала")
            bitrate = int(c["bitrate"]) if c.get("bitrate") else None
        else:
            bitrate = int(c.get("bitrate") or 0)
            if bitrate not in PRESET_BITRATES:
                raise CommandError(f"Скорость {bitrate} не из пресетов — задайте тайминг")
        out["channels"].append({"channel": n, "alias": str(c.get("alias") or ""), "bitrate": bitrate,
                                "timing": timing, "listen_only": bool(c.get("listen_only")),
                                "terminator": bool(c.get("terminator")), "auto_open": bool(c.get("auto_open"))})
    return out


def _comment_key(can_id: int, ext: bool) -> str:
    return f"{int(can_id)}:{1 if ext else 0}"


def row_from_dict(d: dict[str, Any]) -> TraceRow:
    ext = bool(d.get("ext", False))
    can_id = int(d.get("id", 0))
    if not 0 <= can_id <= (0x1FFFFFFF if ext else 0x7FF):
        raise CommandError("ID вне диапазона")
    data = bytes.fromhex(str(d.get("data", "")))
    if len(data) > 8:
        raise CommandError("не более 8 байт данных")
    rtr = bool(d.get("rtr", False))
    if rtr:                                   # у RTR данных нет, а DLC есть: храним DLC нулевых байт
        dlc = int(d.get("dlc", len(data)))
        if not 0 <= dlc <= 8:
            raise CommandError("DLC вне 0..8")
        data = bytes(dlc)
    channel = int(d.get("ch", 1))
    if not 1 <= channel <= 4:
        raise CommandError("канал вне 1..4")
    frame = CanFrame(channel=channel, can_id=can_id, data=data, extended=ext,
                     rtr=rtr, timestamp=finite(d.get("ts", 0.0)))
    return TraceRow(frame, enabled=bool(d.get("enabled", True)), bp=bool(d.get("bp", False)),
                    before_ms=min(max(0, int(d.get("before_ms", 0))), 60_000),
                    after_ms=min(max(0, int(d.get("after_ms", 0))), 60_000),
                    comment=clean_text(str(d.get("comment", ""))))


class Hub:
    def __init__(
        self,
        factory: Callable[..., CanSession],
        store: JsonStore,
        traces_dir: Path,
        data_dir: Path,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        discover: Callable[[dict], Awaitable[dict]] | None = None,
    ) -> None:
        # factory(конфиг подключения, прибор из discover) → сессия; discover(конфиг) →
        # снимок приборов (app/devices.py). Без discover (тесты) прибор не ищется.
        self.factory = factory
        self.discover = discover
        # Одна шкала времени для всего потока: часы хоста. Метки прибора сессия переводит
        # в неё сама (app/devclock.py), кадры Tx получают время хоста в момент отправки.
        self.clock = clock
        self.store = store
        self.traces_dir = Path(traces_dir)
        self.lists_dir = Path(data_dir) / "lists"
        self.clients: set[Client] = set()

        # файлы ./data правят руками и переносят между машинами: файл не того вида —
        # значения по умолчанию, а не падение сервера
        settings = store.load("settings", {})
        self.settings = merge_settings(DEFAULT_SETTINGS, settings if isinstance(settings, dict) else {})
        comments = store.load("comments", {})
        self.comments: dict[str, str] = ({str(k): clean_text(str(v)) for k, v in comments.items()}
                                         if isinstance(comments, dict) else {})
        bitrates = store.load("bitrates", [])
        self.bitrates: list[dict] = [b for b in bitrates if isinstance(b, dict)] if isinstance(bitrates, list) else []
        tz = store.load("tz", None)
        self.tz: str | None = tz if isinstance(tz, str) else None   # часовой пояс браузера (в Docker своё время — UTC)
        try:
            saved = store.load("connection", None)
            self.connection = normalize_connection(saved if isinstance(saved, dict) else default_connection())
        except (CommandError, TypeError, ValueError, KeyError, AttributeError):
            self.connection = default_connection()

        self.session: CanSession | None = None
        self.state = "closed"
        self.message = ""
        self.device_info: dict | None = None
        self.device: dict | None = None            # прибор текущего подключения (из снимка devices)
        self.channels: dict[int, dict] = {}
        self.devices: dict = empty_snapshot(self.connection, "unknown" if discover else "off")
        self._devices_task: asyncio.Task | None = None
        self._scan_lock = asyncio.Lock()

        self.monitor = MonitorState(aggregator=self.settings["aggregator"])
        self.capture = Capture(now=self._local_now)
        self.capture_rev = 0
        self._sent_capture: tuple[bool, bool, bool] = (False, False, False)   # (запись, полон, не сохранён) у клиентов
        self._restoring = True                                    # список передачи читается с диска — не писать его обратно
        self._saved_tx: str | None = None                         # что из списка передачи уже на диске
        self.tx = TransmitManager(send=self._tx_send, sleep=sleep, on_change=self._tx_changed,
                                  on_error=lambda m: self._toast("error", f"Передача остановлена: {m}"),
                                  check=self._check_tx_channel,
                                  on_trigger_error=lambda m: self._toast("error", f"Триггер не сработал: {m}"))
        self.hw = HwFilters(layout_from_device({}))
        self.soft = SoftFilters()
        self._restore_lists()
        self._restoring = False
        self.tracer = TracerDoc()
        self.tracer_rev = 0          # позиции строк (структура, фильтр ID)
        self.tracer_data_rev = 0     # содержимое строк (точки останова, комментарии, запрет)
        self._progress_state = "stopped"          # что последним ушло клиентам
        self._progress_pending: int | None = None  # строка, ещё не отправленная в тике
        self.player = TracePlayer(self.tracer, send=self._player_send, sleep=sleep,
                                  on_progress=self._player_progress,
                                  on_error=lambda m: self._toast("error", f"Отладчик остановлен: {m}"))
        self.player.config.max_1s = self.settings["tracer_max_1s"]

        self._reader_task: asyncio.Task | None = None
        self._ticker_task: asyncio.Task | None = None
        self._connect_task: asyncio.Task | None = None   # идущее подключение (его отменяет disconnect)
        self._save_locks: dict[Path, asyncio.Lock] = {}   # сохранения в один файл — по очереди
        self._bg_tasks: set[asyncio.Task] = set()
        self._rx_count = 0
        self._tx_count = 0
        self._sent_tail = 0
        self._sent_counts: dict[str, int] = {}
        self._stats_at = time.monotonic()
        self._counts_at = 0.0
        self.logger: StreamLogger | None = None   # фоновое логирование потока

    # ------------------------------------------------------------ состояние
    def _restore_lists(self) -> None:
        if self.settings["restore_tx_on_start"]:
            saved = self.store.load("transmit", [])
            try:
                self.tx.load_list(saved if isinstance(saved, list) else [])
            except (ValueError, TypeError, KeyError, AttributeError):
                pass          # битый список не затираем: файл остаётся, задачи — пустые
        if self.settings["filter_restore_on_start"]:
            saved = self.store.load("filters", {}) or {}
            if not isinstance(saved, dict):
                saved = {}
            try:   # раскладка прибора, при которой сохраняли: иначе слоты сверх 14 пропали бы
                layout = {int(k): int(v) for k, v in (saved.get("hw_layout") or {}).items()}
                kinds = {int(k): [str(x) for x in v] for k, v in (saved.get("hw_kinds") or {}).items()}
                if layout:
                    self.hw = HwFilters(layout, kinds)
            except (AttributeError, TypeError, ValueError):
                pass
            self.hw.load_list(saved.get("hw") if isinstance(saved.get("hw"), list) else [])
            self.soft.load_list(saved.get("ranges") if isinstance(saved.get("ranges"), list) else [])

    def _status(self) -> dict[str, Any]:
        return {"type": "status", "state": self.state, "message": self.message,
                "device_info": self.device_info, "device": self.device,
                "log": self.logger.path.name if self.logger is not None and self.logger.path else None,
                "channels": {str(k): v for k, v in sorted(self.channels.items())}}

    def _capture_state(self) -> dict[str, Any]:
        c = self.capture
        self._sent_capture = (c.recording, c.full, c.dirty)
        return {"type": "capture_state", "recording": c.recording, "count": len(c),
                "duration_s": c.duration_s(), "full": c.full, "rev": self.capture_rev,
                "loaded": c.loaded, "dirty": c.dirty,
                "markers": [{"index": m.index, "label": m.label, "comment": m.comment, "auto": m.auto}
                            for m in c.markers]}

    def _filters_state(self) -> dict[str, Any]:
        return {"type": "filters_state", "hw": self.hw.to_list(),
                "hw_layout": {str(k): v for k, v in self.hw.layout.items()}, "ranges": self.soft.to_list()}

    def _tracer_state(self) -> dict[str, Any]:
        cfg = self.player.config
        # gen — номер трейса (открыт, новый, из потока): правка и фильтр ID его не меняют
        return {"type": "tracer_state", "name": self.tracer.name, "modified": self.tracer.modified,
                "count": len(self.tracer.rows), "visible": self.tracer.visible_count(),
                "channels": self.tracer.channels(), "rev": self.tracer_rev, "data_rev": self.tracer_data_rev,
                "gen": self.tracer.generation,
                "state": self.player.state, "current": self.player.current,
                "pos": self.tracer.position(self.player.current) if self.player.current is not None else None,
                **self._pause_reason(self.player.state),
                "config": dict(cfg.__dict__),
                "breakpoints": [{"i": i, "pos": self.tracer.position(i)}
                                for i, r in enumerate(self.tracer.rows) if r.bp]}

    def _pause_reason(self, state: str) -> dict[str, Any]:
        """Почему проигрыватель встал на паузу сам: точка останова или принятый кадр (какой)."""
        reason = self.player.reason if state == "paused" else None
        f = self.player.reason_frame if reason == "rx" else None
        return {"reason": reason, "rx": {"ch": f.channel, "id": f.can_id, "ext": f.extended} if f else None}

    def hello(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "status": self._status(),
            "settings": self.settings,
            "comments": self.comments,
            "connection": self.connection,
            "devices": self.devices,
            "bitrates": self.bitrates,
            "monitor": [row_to_dict(r) for r in self.monitor.snapshot_all()],
            "capture": self._capture_state(),
            "tx": {"tasks": self.tx.to_list()},
            "filters": self._filters_state(),
            "tracer": self._tracer_state(),
        }

    def broadcast(self, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            c.send(msg)

    # ------------------------------------------------------------- клиенты
    async def attach(self, client: Client) -> None:
        self.clients.add(client)
        client.send(self.hello())
        if self._ticker_task is None or self._ticker_task.done():
            self._ticker_task = asyncio.create_task(self._ticker())
        if self.discover is not None and (self._devices_task is None or self._devices_task.done()):
            self._devices_task = asyncio.create_task(self._watch_devices())

    def detach(self, client: Client) -> None:
        self.clients.discard(client)
        if not self.clients and self._devices_task is not None:
            self._devices_task.cancel()      # некому показывать — USB не опрашиваем
            self._devices_task = None

    async def handle(self, client: Client, raw: str | dict) -> None:
        req_id = None
        try:
            msg = parse_message(raw)
            req_id = msg.get("req_id")
            if not isinstance(msg.get("type"), str):
                raise CommandError("message needs a 'type'")
            if not all_finite(msg):
                raise CommandError("NaN и Infinity в командах не допускаются")
            handler = getattr(self, f"_cmd_{msg['type']}", None)
            if handler is None:
                raise CommandError(f"unknown command type: {msg['type']}")
            if msg["type"] in BACKGROUND_COMMANDS:
                task = asyncio.create_task(self._run(client, handler, msg, req_id))
                self._bg_tasks.add(task)
                task.add_done_callback(self._bg_tasks.discard)
                return
        except Exception as e:   # невалидный ввод не рвёт сокет
            self._reply_error(client, req_id, e)
            return
        await self._run(client, handler, msg, req_id)

    async def _run(self, client: Client, handler, msg: dict, req_id) -> None:
        try:
            data = await handler(msg)
        except asyncio.CancelledError:
            if req_id is not None:
                client.send({"type": "reply", "req_id": req_id, "ok": False, "error": "Отменено"})
            task = asyncio.current_task()
            if task is not None and getattr(task, "cancelling", lambda: 1)():
                raise
            return
        except Exception as e:
            self._reply_error(client, req_id, e)
            return
        if req_id is not None:
            client.send({"type": "reply", "req_id": req_id, "ok": True, "data": data})

    @staticmethod
    def _reply_error(client: Client, req_id, e: Exception) -> None:
        text = str(e) or e.__class__.__name__
        if req_id is not None:
            client.send({"type": "reply", "req_id": req_id, "ok": False, "error": text})
        else:
            client.send({"type": "error", "message": text})

    async def shutdown(self) -> None:
        self.tx.shutdown()
        self.player.stop()
        self._log_stop()                 # иначе фоновый лог останется недописанным .trc.part
        for t in (self._reader_task, self._ticker_task, self._connect_task, self._devices_task, *self._bg_tasks):
            if t is not None:
                t.cancel()
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
            self.session = None

    # ----------------------------------------------------------- подключение
    def _require_session(self) -> CanSession:
        if self.session is None:
            raise CommandError("Нет подключения к устройству")
        return self.session

    async def _close_session(self) -> None:
        # сначала отцепить сессию от состояния (пока ждём закрытия, придёт и новое
        # подключение, и отключение), потом закрыть её — даже если нас самих отменят
        reader, self._reader_task = self._reader_task, None
        if reader is not None:
            reader.cancel()
        self.tx.pause_all()
        self.player.stop()
        self._log_stop()
        session, self.session = self.session, None
        self.channels = {}
        self.device = None
        if session is not None:
            try:
                await asyncio.shield(self._safe_close(session))
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

    async def _cmd_connect(self, msg: dict) -> dict:
        cfg = normalize_connection(msg.get("config") or {})
        self.connection = cfg
        self.store.save("connection", cfg)
        self.broadcast({"type": "connection", "connection": cfg})   # диалог у всех вкладок — с новым конфигом
        # последнее «Подключиться» главнее: сначала встать на место текущего (тогда
        # «Отключиться», пришедшее, пока ждём прежнее, отменит уже нас), потом снять прежнее
        me = asyncio.current_task()
        prev, self._connect_task = self._connect_task, me
        try:
            if prev is not None and prev is not me and not prev.done():
                prev.cancel()
                await asyncio.wait({prev})
            return await self._connect(cfg)
        finally:
            if self._connect_task is me:
                self._connect_task = None

    async def _cancel_connect(self) -> None:
        t = self._connect_task
        if t is not None and t is not asyncio.current_task() and not t.done():
            t.cancel()
            await asyncio.wait({t})
        if self._connect_task is t:
            self._connect_task = None

    @staticmethod
    async def _safe_close(session: CanSession) -> None:
        try:
            await session.close()
        except Exception:
            pass

    # --------------------------------------------------------------- приборы
    async def _scan_devices(self, cfg: dict) -> dict:
        """Снимок приборов по адресу моста из cfg; для сохранённого адреса он же становится
        текущим и расходится вкладкам (только если что-то изменилось)."""
        async with self._scan_lock:                 # опросы по очереди: старый снимок не перетрёт новый
            snap = await self.discover(cfg)
            same_bridge = (cfg["bridge_host"], cfg["bridge_port"]) == (
                self.connection["bridge_host"], self.connection["bridge_port"])
            if same_bridge and snap != self.devices:
                self.devices = snap
                self.broadcast({"type": "devices", **snap})
            return snap

    async def _watch_devices(self) -> None:
        """Пока открыт интерфейс — следит, воткнули ли прибор в USB (как таймер списка
        источников в десктопе)."""
        while True:
            try:
                await self._scan_devices(self.connection)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass          # сбой опроса — следующий через DEVICE_POLL_S
            await asyncio.sleep(DEVICE_POLL_S)

    async def _cmd_devices_scan(self, msg: dict) -> dict:
        cfg = dict(self.connection)
        if msg.get("bridge_host") is not None or msg.get("bridge_port") is not None:
            try:
                cfg.update(normalize_connection({**cfg, "bridge_host": msg.get("bridge_host", cfg["bridge_host"]),
                                                 "bridge_port": msg.get("bridge_port", cfg["bridge_port"])}))
            except (TypeError, ValueError) as e:
                raise CommandError("Неверный адрес моста") from e
        if self.discover is None:
            return dict(self.devices)
        return await self._scan_devices(cfg)

    async def _connect(self, cfg: dict) -> dict:
        await self._close_session()
        self.state, self.message = "opening", ""
        self.broadcast(self._status())
        session = None
        try:
            device = None
            if self.discover is not None:          # свежий снимок: прибор могли только что воткнуть
                device = pick(await self._scan_devices(cfg), cfg["device"])
            session = self.factory(cfg, device)
            await session.connect()
            info = await session.get_device_info()
        except asyncio.CancelledError:
            if session is not None:
                await self._safe_close(session)
            raise
        except Exception as e:
            if session is not None:
                await self._safe_close(session)
            self.state, self.message = "error", str(e) or e.__class__.__name__
            self.broadcast(self._status())
            raise CommandError(self.message) from None
        self.session = session
        self.device = device
        self.device_info = info
        try:
            layout = layout_from_device(info)
            if layout != self.hw.layout or self.hw.kinds != layout_kinds(info):
                old = self.hw.to_list()
                self.hw = HwFilters(layout, layout_kinds(info))
                self.hw.load_list(old)
            for ch in cfg["channels"]:
                await self._open_channel(ch)
            await self._apply_filters_on_connect()
        except asyncio.CancelledError:
            await self._close_session()
            self.state, self.message = "closed", ""
            self.broadcast(self._status())
            raise
        self._reader_task = asyncio.create_task(self._reader(session))
        if self.settings["log_autostart"]:
            self._log_start()
        self.state = "opened"
        self.broadcast(self._status())
        self.broadcast(self._filters_state())
        return {}

    async def _apply_filters_on_connect(self) -> None:
        """Слоты прибора приводим к сохранённым: сначала сброс (прибор мог сохранить
        фильтры прошлой сессии), потом включённые. Отказ прибора по слоту — предупреждение,
        подключение не срывается."""
        failed = []
        for n, st in sorted(self.channels.items()):
            if not st.get("open"):
                continue
            try:
                await self.session.clear_filters(n)
            except Exception:
                pass          # сброс — лишь подстраховка; не все прошивки его знают
            for slot in self.hw.slots:
                if slot.channel == n and slot.enabled:
                    try:
                        await self.session.set_hw_filter(slot.channel, slot.index, slot.can_id, slot.mask, slot.ext)
                    except Exception as e:
                        failed.append(f"канал {n}, фильтр {slot.index}: {e}")
        if failed:
            self._toast("warning", "Прибор не принял фильтры — " + "; ".join(failed))

    async def _open_channel(self, ch: dict) -> None:
        n = ch["channel"]
        st = {"open": False, "alias": ch["alias"], "bitrate": ch["bitrate"], "timing": ch["timing"],
              "listen_only": ch["listen_only"], "terminator": False, "error": None}
        self.channels[n] = st
        if not ch["auto_open"]:
            return
        try:
            await self.session.open_channel(n, ch["bitrate"], ch["listen_only"], timing=ch["timing"])
            st["open"] = True
        except Exception as e:
            st["error"] = str(e)
            return
        if not ch["terminator"]:
            return
        if not self._has_terminator(n):
            self._toast("warning", f"Канал {n}: прибор не поддерживает терминатор 120 Ом")
            return
        try:
            await self.session.set_terminator(n, True)
            st["terminator"] = True
        except Exception as e:
            self._toast("error", f"Канал {n}: терминатор не включён: {e}")

    def _has_terminator(self, n: int) -> bool:
        feats = (self.device_info or {}).get("channel_features") or {}
        return bool((feats.get(n) or feats.get(str(n)) or {}).get("terminator"))

    def _toast(self, level: str, message: str) -> None:
        self.broadcast({"type": "toast", "level": level, "message": message})

    async def _cmd_disconnect(self, msg: dict) -> dict:
        await self._cancel_connect()
        await self._close_session()
        self.state, self.message = "closed", ""
        self.broadcast(self._status())
        return {}

    async def _cmd_channel_terminator(self, msg: dict) -> dict:
        n = int(msg["channel"])
        session = self._require_session()
        if not self._has_terminator(n):
            raise CommandError(f"Прибор не поддерживает терминатор на канале {n}")
        await session.set_terminator(n, bool(msg["enabled"]))
        if n in self.channels:
            self.channels[n]["terminator"] = bool(msg["enabled"])
        self.broadcast(self._status())
        return {}

    async def _reader(self, session: CanSession) -> None:
        try:
            async for f in session.frames():
                await self._on_rx(f)
        except asyncio.CancelledError:
            raise
        except Exception as e:   # обрыв моста/прибора в середине сессии — сообщить, не молчать
            self._reader_task = None
            await self._close_session()
            self.state, self.message = "error", f"Приём остановлен: {e}"
            self.broadcast(self._status())

    async def _on_rx(self, f: CanFrame) -> None:
        if not self.soft.accept(f):
            return
        self._rx_count += 1
        self.monitor.update(f)
        self.capture.append(f)
        if self.logger is not None:
            self.logger.write(f)
        await self.tx.on_frame(f)
        self.player.notify_rx(f)

    def _check_tx_channel(self, n: int) -> None:
        """Прибор молча отбрасывает кадр для закрытого канала и не может передавать в
        режиме «Только слушать» — не делаем вид, что кадр ушёл в шину."""
        st = self.channels.get(n)
        if not st or not st.get("open"):
            raise CommandError(f"Канал {n} не открыт")
        if st.get("listen_only"):
            raise CommandError(f"Канал {n} открыт в режиме «Только слушать» — передача невозможна")

    async def _tx_send(self, frame: CanFrame) -> None:
        session = self._require_session()
        self._check_tx_channel(frame.channel)
        await session.send(frame)
        out = replace(frame, timestamp=self.clock(), ts_source="arrival", direction="tx")
        self._tx_count += 1
        self.capture.append(out)
        if self.logger is not None:
            self.logger.write(out)          # TX или нет — решает логгер по настройке

    # ---------------------------------------------------------------- тикер
    async def _ticker(self) -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                self._tick()
            except Exception as e:   # тикер не должен умирать молча
                self.broadcast({"type": "error", "message": f"tick: {e}"})

    def _tick(self) -> None:
        if self._progress_pending is not None:
            self._send_progress(self._progress_pending, self._progress_state)
            self._progress_pending = None
        rows = self.monitor.snapshot_delta()
        if rows:
            self.broadcast({"type": "monitor_delta", "rows": [row_to_dict(r) for r in rows]})
        n = len(self.capture)
        if n != self._sent_tail:
            start = max(0, n - 100)
            self.broadcast({"type": "capture_tail", "count": n, "duration_s": self.capture.duration_s(),
                            "rev": self.capture_rev, "start": start, "rows": self.capture.rows(start, n - start)})
            self._sent_tail = n
        if (self.capture.recording, self.capture.full, self.capture.dirty) != self._sent_capture:
            self.broadcast(self._capture_state())     # буфер заполнился — запись встала сама; пошли несохранённые кадры
        now = time.monotonic()
        if now - self._counts_at >= 0.25:
            self._counts_at = now
            counts = {t.id: t.count for t in self.tx.tasks}
            if counts != self._sent_counts:
                self.broadcast({"type": "tx_counts", "counts": counts})
                self._sent_counts = counts
        if now - self._stats_at >= 1.0:
            dt = now - self._stats_at
            self.broadcast({"type": "stats", "rx_per_s": round(self._rx_count / dt),
                            "tx_per_s": round(self._tx_count / dt)})
            self._rx_count = self._tx_count = 0
            self._stats_at = now

    # -------------------------------------------------------------- монитор
    async def _cmd_monitor_clear(self, msg: dict) -> dict:
        self.monitor.clear()
        self.broadcast({"type": "monitor_reset"})
        return {}

    async def _cmd_monitor_frames(self, msg: dict) -> dict:
        rows = self.monitor.unique_frames(int(msg["ch"]), int(msg["id"]), bool(msg.get("ext", False)))
        return {"rows": [{"data": u.data.hex(), "count": u.count, "period_ms": u.period_ms, "ts": u.last_ts}
                         for u in rows]}

    async def _cmd_comment_set(self, msg: dict) -> dict:
        ext = bool(msg.get("ext", False))
        can_id = int(msg["id"])
        if not 0 <= can_id <= (0x1FFFFFFF if ext else 0x7FF):
            raise CommandError("ID вне диапазона")
        key = _comment_key(can_id, ext)
        text = clean_text(str(msg.get("text") or ""))
        if text:
            self.comments[key] = text
        else:
            self.comments.pop(key, None)
        self._comments_changed()
        return {}

    def _comments_changed(self) -> None:
        self.store.save("comments", self.comments)
        self.broadcast({"type": "comments", "comments": self.comments})

    async def _cmd_comments_clear(self, msg: dict) -> dict:
        self.comments = {}
        self._comments_changed()
        return {}

    async def _cmd_comments_save(self, msg: dict) -> dict:
        ext = ".json" if msg.get("format") == "json" else ".cmt"
        name = safe_name(msg.get("name"), COMMENT_EXT, ext)
        if name.lower().endswith(".cmt"):
            self._write_text(name, format_cmt(self.comments))
        else:
            self._write_list(name, {"kind": "comments", "comments": self.comments})
        return {"name": name}

    async def _cmd_comments_load(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), COMMENT_EXT)
        if name.lower().endswith(".cmt"):
            loaded = parse_cmt(self._read_text(name))
        else:
            data = self._read_list(name)
            if not isinstance(data.get("comments"), dict):
                raise CommandError("В файле нет комментариев")
            loaded = {str(k): clean_text(str(v)) for k, v in data["comments"].items()}
        self.comments = {**self.comments, **loaded} if msg.get("append") else loaded
        self._comments_changed()
        return {}

    async def _cmd_settings_set(self, msg: dict) -> dict:
        before = self.settings
        self.settings = merge_settings(self.settings, msg.get("patch") or {})
        if self.settings["aggregator"] != before["aggregator"]:
            self.monitor.set_aggregator(self.settings["aggregator"])
        if self.logger is not None:
            self.logger.settings = self.settings
        if self.settings["log_autostart"] != before["log_autostart"]:
            if self.settings["log_autostart"] and self.session is not None:
                self._log_start()
            elif not self.settings["log_autostart"]:
                self._log_stop()
            self.broadcast(self._status())
        if self.settings["tracer_max_1s"] != self.player.config.max_1s:
            self.player.config = PlayerConfig.from_patch(self.player.config, {"max_1s": self.settings["tracer_max_1s"]})
            self._tracer_changed()
        self.store.save("settings", self.settings)
        self.broadcast({"type": "settings", "settings": self.settings})
        return {"settings": self.settings}

    # ------------------------------------------------- местное время
    def _local_now(self) -> datetime:
        """Местное время пользователя — для имени лога и `# $LocalTime` трейсов."""
        if self.tz:
            try:
                return datetime.now(ZoneInfo(self.tz))
            except (KeyError, ValueError):
                pass
        return datetime.now().astimezone()

    async def _cmd_client_tz(self, msg: dict) -> dict:
        tz = str(msg.get("tz") or "")
        try:
            ZoneInfo(tz)
        except (KeyError, ValueError):
            raise CommandError(f"Неизвестный часовой пояс: {tz}") from None
        if tz != self.tz:
            self.tz = tz
            self.store.save("tz", tz)
        return {}

    # ------------------------------------------------- фоновое логирование
    def _log_start(self) -> None:
        if self.logger is not None:
            return
        self.logger = StreamLogger(self.traces_dir, self.settings, now=self._local_now)
        self.logger.start(trc_meta(self.settings["log_meta"]))

    def _log_stop(self) -> None:
        logger, self.logger = self.logger, None
        if logger is None:
            return
        path = logger.stop()
        if path is not None:
            self._toast("info", f"Записан трейс: {path.name}")

    async def _cmd_bitrates_set(self, msg: dict) -> dict:
        items = []
        for b in msg.get("bitrates") or []:
            t = b.get("timing") or {}
            try:
                timing = {k: int(t[k]) for k in ("prescaler", "seg1", "seg2", "sjw")}
            except (KeyError, TypeError, ValueError):
                raise CommandError("Неверный тайминг скорости") from None
            if not all(v > 0 for v in timing.values()):
                raise CommandError("Неверный тайминг скорости")
            items.append({"caption": str(b.get("caption") or ""), "bitrate": int(b.get("bitrate") or 0),
                          "sample_pct": finite(b.get("sample_pct") or 75.0),
                          "clock_hz": int(b.get("clock_hz") or DEFAULT_CLOCK_HZ), "timing": timing})
        self.bitrates = items
        self.store.save("bitrates", items)
        self.broadcast({"type": "bitrates", "bitrates": items})
        return {}

    # ---------------------------------------------------------------- поток
    def _capture_changed(self, reset: bool = False) -> None:
        if reset:
            self.capture_rev += 1
            self._sent_tail = -1
        self.broadcast(self._capture_state())

    async def _cmd_capture_record(self, msg: dict) -> dict:
        c = self.capture
        if msg.get("on") and c.loaded is not None and not c.recording:
            # трейс из файла и живые кадры — разные записи с разной шкалой времени (в .trc время
            # от нуля): дописывать к файлу нельзя, F5 начинает новую запись; файл на диске цел
            name = c.loaded
            c.clear()
            c.start()
            self._capture_changed(reset=True)
            self._toast("info", f"Начата новая запись — загруженный поток «{name}» убран из окна (файл не изменён)")
            return {}
        c.start() if msg.get("on") else c.pause()
        self._capture_changed()
        return {}

    async def _cmd_capture_clear(self, msg: dict) -> dict:
        self.capture.clear()
        self._capture_changed(reset=True)
        return {}

    async def _cmd_capture_frames(self, msg: dict) -> dict:
        """«Данные сообщения» (Ctrl+F3) в режиме потока — по записанному/загруженному буферу."""
        scan = self.capture.unique_frames(int(msg["ch"]), int(msg["id"]), bool(msg.get("ext", False)))
        return {"rows": await asyncio.to_thread(scan), "rev": self.capture_rev}

    async def _cmd_capture_rows(self, msg: dict) -> dict:
        count = min(int(msg.get("count", 100)), MAX_ROWS_PER_REQUEST)
        return {"rows": self.capture.rows(int(msg.get("start", 0)), count), "rev": self.capture_rev}

    async def _cmd_capture_marker(self, msg: dict) -> dict:
        label = clean_text(str(msg.get("label") or ""))
        if msg.get("auto") or not label:
            label = f"#{len(self.capture.markers) + 1}"     # номер — по всем меткам, без повторов
        m = self.capture.add_marker(label, clean_text(str(msg.get("comment") or "")), auto=bool(msg.get("auto")))
        self._capture_changed()
        return {"index": m.index, "label": m.label}

    def _save_lock(self, path: Path) -> asyncio.Lock:
        lock = self._save_locks.get(path)
        if lock is None:
            lock = self._save_locks[path] = asyncio.Lock()
        return lock

    def _trace_file(self, name: Any) -> Path:
        name = safe_name(name, TRACE_EXT)
        path = self.traces_dir / name
        if not path.is_file():
            raise CommandError(f"Файл {name} не существует!")
        return path

    async def _cmd_capture_save(self, msg: dict) -> dict:
        """Колонки копируются здесь (быстро), файл пишется в отдельном потоке: запись
        потока и передача в это время не встают."""
        ext = ".jsonl" if msg.get("format") == "jsonl" else ".trc"
        name = safe_name(msg.get("name"), TRACE_EXT, ext)
        c = self.capture
        if c.meta:                     # загруженный трейс — его метаинформация и время начала
            meta, local_time = dict(c.meta), c.started_at
        else:
            meta, local_time = trc_meta(self.settings["log_meta"]), c.started_at or self._local_now()
        doc = TraceDoc(frames=c.snapshot(), markers=copy_markers(c.markers), meta=meta,
                       id_comments=dict(self.comments))
        path = self.traces_dir / name
        n_frames, n_markers = len(doc.frames), len(doc.markers)
        async with self._save_lock(path):
            await asyncio.to_thread(write_trace, path, doc, local_time)
        if (len(c), len(c.markers)) == (n_frames, n_markers):     # пока писали файл, ничего не добавилось
            c.dirty = False
            self._capture_changed()
        self.broadcast({"type": "toast", "level": "info", "message": "Поток данных сохранён!"})
        return {"name": name}

    async def _cmd_capture_load(self, msg: dict) -> dict:
        path = self._trace_file(msg.get("name"))
        limit, now = self.capture.limit, self.capture._now

        def build() -> tuple[Capture, int, int]:
            doc = read_trace(path)
            cap = Capture(limit=limit, now=now)
            cap.load(doc.frames, doc.markers, doc.meta)
            return cap, len(doc.frames), doc.skipped

        cap, count, skipped = await asyncio.to_thread(build)
        cap.loaded = path.name
        self.capture.adopt(cap)                  # загрузка останавливает запись: живые кадры не дописываются к файлу
        self._capture_changed(reset=True)
        return {"count": count, "skipped": skipped}

    async def _cmd_capture_to_tracer(self, msg: dict) -> dict:
        c = self.capture
        # ID-комментарии в строки не копируем: отладчик показывает их из общего списка
        # (их правка и очистка видны сразу), в файл они подставляются при сохранении
        doc = TraceDoc(frames=c.snapshot(), markers=copy_markers(c.markers))
        new = await asyncio.to_thread(TracerDoc.from_doc, doc, None)
        self._tracer_load(new)
        return {"count": len(new.rows)}

    # ------------------------------------------------------------- передача
    def _tx_changed(self) -> None:
        if self._restoring:
            return
        tasks = self.tx.to_list()
        # на диск — только когда поменялось содержимое списка, а не «запущена/стоит» или счётчик
        key = json.dumps([{k: v for k, v in t.items() if k not in ("running", "count")} for t in tasks],
                         sort_keys=True)
        if key != self._saved_tx:
            self.store.save("transmit", tasks)
            self._saved_tx = key
        self.broadcast({"type": "tx_state", "tasks": tasks})

    async def _cmd_tx_upsert(self, msg: dict) -> dict:
        self.tx.upsert(task_from_dict(msg.get("task") or {}))
        return {}

    async def _cmd_tx_delete(self, msg: dict) -> dict:
        self.tx.delete(str(msg["id"]))
        return {}

    async def _cmd_tx_clear(self, msg: dict) -> dict:
        self.tx.clear()
        return {}

    async def _cmd_tx_send(self, msg: dict) -> dict:
        await self.tx.send_once(str(msg["id"]))
        return {}

    async def _cmd_tx_start(self, msg: dict) -> dict:
        self._require_session()
        task = self.tx._get(str(msg["id"]))
        self._check_tx_channel(task.channel)       # сразу понятная ошибка вместо запуска и падения цикла
        self.tx.start(task.id)
        return {}

    async def _cmd_tx_pause(self, msg: dict) -> dict:
        self.tx.pause(str(msg["id"]))
        return {}

    async def _cmd_tx_start_all(self, msg: dict) -> dict:
        self._require_session()
        skipped = []                                # (задача, почему её канал не передаёт)
        for t in list(self.tx.tasks):
            try:
                self._check_tx_channel(t.channel)
            except CommandError as e:
                skipped.append((t, str(e)))
                continue
            self.tx.start(t.id)
        if skipped:
            self._toast("warning", skipped_text(skipped))
        return {}

    async def _cmd_tx_pause_all(self, msg: dict) -> dict:
        self.tx.pause_all()
        return {}

    async def _cmd_tx_reset(self, msg: dict) -> dict:
        self.tx.reset(msg.get("id"))
        return {}

    async def _cmd_tx_save(self, msg: dict) -> dict:
        ext = ".json" if msg.get("format") == "json" else ".tsk"
        name = safe_name(msg.get("name"), TASK_EXT, ext)
        if name.lower().endswith(".tsk"):
            self._write_text(name, format_tsk(self.tx.to_list()))
        else:
            self._write_list(name, {"kind": "transmit", "transmit": self.tx.to_list()})
        return {"name": name}

    async def _cmd_tx_load(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), TASK_EXT)
        if name.lower().endswith(".tsk"):
            text = self._read_text(name)
            tasks = parse_tsk(text)
            if not tasks and text.strip("﻿ \t\r\n"):
                # не список задач десктопа (мусор, другой файл) — текущий список не трогаем;
                # пустой файл — это сохранённый пустой список, его загрузка список очищает
                raise CommandError("В файле нет списка передачи")
            self.tx.load_list(tasks)
        else:
            items = self._read_list(name).get("transmit")
            if not isinstance(items, list):
                raise CommandError("В файле нет списка передачи")
            self.tx.load_list(items)
        return {"count": len(self.tx.tasks)}

    # -------------------------------------------------------------- фильтры
    def _filters_changed(self) -> None:
        self.store.save("filters", {"hw_layout": {str(k): v for k, v in self.hw.layout.items()},
                                    "hw_kinds": {str(k): v for k, v in self.hw.kinds.items()},
                                    "hw": self.hw.to_list(), "ranges": self.soft.to_list()})
        self.broadcast(self._filters_state())

    async def _apply_slot(self, slot) -> None:
        if self.session is None or not self.channels.get(slot.channel, {}).get("open"):
            return            # закрытому каналу фильтры применятся при подключении
        if slot.enabled:
            await self.session.set_hw_filter(slot.channel, slot.index, slot.can_id, slot.mask, slot.ext)
        else:
            await self.session.clear_hw_filter(slot.channel, slot.index)

    async def _cmd_hw_set(self, msg: dict) -> dict:
        slot = slot_from_dict(msg.get("slot") or {})
        self.hw.check(slot)
        await self._apply_slot(slot)          # прибор отказал — состояние не меняем
        self.hw.set(slot)
        self._filters_changed()
        return {}

    async def _cmd_filters_add_id(self, msg: dict) -> dict:
        ch, ext, can_id = int(msg["channel"]), bool(msg.get("ext", False)), int(msg["id"])
        slot = self.hw.slot_for_id(ch, can_id, ext)
        if slot is None:
            raise CommandError("Не могу добавить фильтр.")
        if slot.enabled and slot.can_id == can_id:
            return {"index": slot.index}          # этот ID уже в фильтре и включён — ничего не менять
        slot = replace(slot, enabled=bool(self.settings["filter_new_active"]), can_id=can_id,
                       mask=0x1FFFFFFF if ext else 0x7FF, ext=ext)
        self.hw.check(slot)
        await self._apply_slot(slot)
        self.hw.set(slot)
        self._filters_changed()
        return {"index": slot.index}

    async def _cmd_range_upsert(self, msg: dict) -> dict:
        d = dict(msg.get("filter") or {})
        if not d.get("id"):
            d["id"] = f"r{int(time.time() * 1000) % 10_000_000}-{len(self.soft.ranges)}"
        self.soft.upsert(range_from_dict(d))
        self._filters_changed()
        return {"id": d["id"]}

    async def _cmd_range_delete(self, msg: dict) -> dict:
        self.soft.delete(str(msg["id"]))
        self._filters_changed()
        return {}

    async def _cmd_hw_save(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), FILTER_EXT, ".json")
        self._write_list(name, {"kind": "filters", "hw": self.hw.to_list(), "ranges": self.soft.to_list()})
        return {"name": name}

    async def _cmd_hw_load(self, msg: dict) -> dict:
        data = self._read_list(safe_name(msg.get("name"), FILTER_EXT))
        hw, ranges = data.get("hw"), data.get("ranges")
        if not isinstance(hw, list) and not isinstance(ranges, list):
            raise CommandError("В файле нет фильтров")
        if isinstance(hw, list):
            self.hw.load_list(hw)
        if isinstance(ranges, list):
            self.soft.load_list(ranges)
        failed = []
        for slot in self.hw.slots:
            try:
                await self._apply_slot(slot)
            except Exception as e:
                failed.append(f"фильтр {slot.index} канала {slot.channel}: {e}")
        self._filters_changed()
        if failed:
            self._toast("warning", "Прибор не принял фильтры — " + "; ".join(failed))
        return {}

    # ------------------------------------------------------------- отладчик
    def _tracer_changed(self, reset: bool = False, data: bool = False) -> None:
        """reset — сдвинулись позиции строк (клиент сбрасывает и выделение);
        data — поменялось только содержимое строк (клиент перечитывает видимые)."""
        if reset:
            self.tracer_rev += 1
        if reset or data:
            self.tracer_data_rev += 1
        self.broadcast(self._tracer_state())

    def _player_progress(self, current: int | None, state: str) -> None:
        """Смена состояния — клиентам сразу; строки во время игры — не чаще тика."""
        if state == "playing" and self._progress_state == "playing":
            self._progress_pending = current
            return
        self._progress_state = state
        self._progress_pending = None
        self._send_progress(current, state)

    def _send_progress(self, current: int | None, state: str) -> None:
        pos = self.tracer.position(current) if current is not None else None
        self.broadcast({"type": "tracer_progress", "current": current, "pos": pos, "state": state,
                        **self._pause_reason(state)})

    def _tracer_index(self, msg: dict, key: str = "pos") -> int:
        """Строка по позиции среди видимых (так её видит таблица отладчика)."""
        found = self.tracer.indices([int(msg[key])])
        if not found:
            raise CommandError("Нет такой строки в трейсе")
        return found[0]

    def _cursor_reply(self, pos: int | None) -> dict[str, Any]:
        """Ответ правки, сдвигающей позиции: ревизия, после которой они верны, и позиция для
        курсора (в пределах видимых строк) — по tracer_state с этой ревизией клиент сбросит
        выделение и поставит курсор сюда."""
        n = self.tracer.visible_count()
        return {"rev": self.tracer_rev, "pos": None if pos is None or n == 0 else min(max(0, pos), n - 1)}

    async def _player_send(self, frame: CanFrame, target: str) -> None:
        if target == "monitor":
            self.monitor.update(replace(frame, timestamp=self.clock(), ts_source="arrival", direction="rx"))
        else:
            await self._tx_send(frame)

    def _tracer_load(self, new: TracerDoc) -> None:
        self.player.stop()
        self.tracer.adopt(new)
        if self.player.config.only_channel not in (None, *self.tracer.channels()):
            # «Только для канала» от прошлого трейса: в этом такого канала нет — играть было бы нечего
            self.player.config = PlayerConfig.from_patch(self.player.config, {"only_channel": None})
        self._tracer_changed(reset=True)

    async def _cmd_tracer_new(self, msg: dict) -> dict:
        self._tracer_load(TracerDoc.from_doc(TraceDoc(frames=[]), None))
        return {}

    async def _cmd_tracer_open(self, msg: dict) -> dict:
        path = self._trace_file(msg.get("name"))

        def build() -> tuple[TracerDoc, int]:
            doc = read_trace(path)
            return TracerDoc.from_doc(doc, path.name), doc.skipped

        new, skipped = await asyncio.to_thread(build)
        self._tracer_load(new)
        return {"count": len(new.rows), "skipped": skipped}

    async def _cmd_tracer_save(self, msg: dict) -> dict:
        raw = msg.get("name") or self.tracer.name
        if not raw:
            raise CommandError("Укажите имя файла")
        ext = ".jsonl" if msg.get("format") == "jsonl" else ".trc"
        name = safe_name(raw, TRACE_EXT, ext)
        t = self.tracer
        rows, markers, meta = list(t.rows), copy_markers(t.markers), dict(t.meta)
        edits, generation = t.edits, t.generation
        id_comments = dict(self.comments)
        path = self.traces_dir / name

        def build_and_write() -> int:
            doc = trace_doc_from_rows(rows, markers, meta)
            doc.id_comments = id_comments          # строкам без своего комментария — комментарий сообщения
            write_trace(path, doc)
            return len(doc.pauses)

        async with self._save_lock(path):
            pauses = await asyncio.to_thread(build_and_write)
        if t.generation == generation:             # пока писали, не открыли другой трейс
            t.name = name
            if t.edits == edits:                   # и этот не правили
                t.modified = False
        self._tracer_changed()
        if pauses and name.lower().endswith(".trc"):
            self._toast("warning", f"Паузы строк ({pauses}) в .trc не сохраняются — для них сохраните в .jsonl")
        return {"name": name}

    async def _cmd_tracer_rows(self, msg: dict) -> dict:
        count = min(int(msg.get("count", 100)), MAX_ROWS_PER_REQUEST)
        return {"rows": self.tracer.rows_view(int(msg.get("start", 0)), count), "rev": self.tracer_rev,
                "data_rev": self.tracer_data_rev}

    async def _cmd_tracer_ids(self, msg: dict) -> dict:
        return {"ids": self.tracer.ids()}

    async def _cmd_tracer_ids_set(self, msg: dict) -> dict:
        keys = [(int(k[0]), int(k[1]), bool(k[2])) for k in msg.get("keys") or []]
        self.tracer.set_ids_enabled(keys, bool(msg.get("enabled")))
        self._tracer_changed(reset=True)            # видимые строки и их позиции сменились
        return {"ids": self.tracer.ids()}

    async def _cmd_tracer_find(self, msg: dict) -> dict:
        k = msg["key"]
        return {"positions": self.tracer.find((int(k[0]), int(k[1]), bool(k[2])))}

    async def _cmd_tracer_row_add(self, msg: dict) -> dict:
        """Без `after` — в конец трейса («Добавить»), иначе сразу после строки («Вставить»).
        Без метки времени строка получает время соседа — паузы по меткам не ломаются."""
        d = msg.get("row") or {}
        after = msg.get("after")
        prev = None if after is None else self._tracer_index(msg, "after")
        row = row_from_dict(d)
        if "ts" not in d:
            rows = self.tracer.rows
            ref = rows[prev] if prev is not None else (rows[-1] if rows else None)
            row.frame = replace(row.frame, timestamp=ref.frame.timestamp if ref else 0.0)
        self.player.stop()                 # вставка сдвигает индексы строк, по которым идёт проигрыватель
        idx = self.tracer.add(row, None if prev is None else prev + 1)
        self._tracer_changed(reset=True)
        # вставленная строка может сразу уйти под фильтр ID — тогда позиции нет
        return {"index": idx, **self._cursor_reply(self.tracer.position(idx))}

    async def _cmd_tracer_row_edit(self, msg: dict) -> dict:
        """Редактор шлёт сообщение и паузы; время и флаги строки, которых нет в запросе, сохраняем."""
        idx = self._tracer_index(msg)
        pos = int(msg["pos"])
        old = self.tracer.rows[idx]
        d = msg.get("row") or {}
        row = row_from_dict(d)
        # время (если его нет в запросе), направление и источник метки строки сохраняем
        row.frame = replace(row.frame, timestamp=row.frame.timestamp if "ts" in d else old.frame.timestamp,
                            direction=old.frame.direction, ts_source=old.frame.ts_source)
        for flag in ("enabled", "bp", "comment"):
            if flag not in d:
                setattr(row, flag, getattr(old, flag))
        row.start, row.finish = old.start, old.finish
        self.tracer.edit(idx, row)
        # позиции сдвигаются, только если строка ушла под фильтр ID — тогда на её позиции
        # оказывается следующая строка, курсор остаётся там же
        self._tracer_changed(reset=self.tracer.position(idx) is None, data=True)
        return self._cursor_reply(pos)

    async def _cmd_tracer_bounds(self, msg: dict) -> dict:
        which = str(msg.get("which"))
        if which not in ("start", "finish"):
            raise CommandError(f"неизвестная граница трейса: {which}")
        index = None if msg.get("pos") is None else self._tracer_index(msg)
        self.tracer.set_bound(which, index)
        self._tracer_changed(data=True)
        return {}

    async def _cmd_tracer_rows_delete(self, msg: dict) -> dict:
        n = self.tracer.visible_count()
        positions = sorted({p for p in (int(x) for x in msg.get("positions") or []) if 0 <= p < n})
        if not positions:
            return {}
        self.player.stop()                 # удаление сдвигает индексы строк, по которым идёт проигрыватель
        self.tracer.delete(self.tracer.indices(positions))
        self._tracer_changed(reset=True)
        # курсор — на строку, шедшую за последней удалённой: она поднялась на число удалённых
        return self._cursor_reply(positions[-1] + 1 - len(positions))

    async def _cmd_tracer_rows_enable(self, msg: dict) -> dict:
        on = bool(msg.get("enabled"))
        if msg.get("key") is not None:
            k = msg["key"]
            self.tracer.set_enabled_by_id((int(k[0]), int(k[1]), bool(k[2])), on)
        else:
            self.tracer.set_enabled(self.tracer.indices([int(p) for p in msg.get("positions") or []]), on)
        self._tracer_changed(data=True)
        return {}

    async def _cmd_tracer_bp(self, msg: dict) -> dict:
        idx = self._tracer_index(msg)
        on = msg.get("on")
        self.tracer.set_bp(idx, (not self.tracer.rows[idx].bp) if on is None else bool(on))
        self._tracer_changed(data=True)
        return {}

    async def _cmd_tracer_bp_clear(self, msg: dict) -> dict:
        for r in self.tracer.rows:
            r.bp = False
        self._tracer_changed(data=True)
        return {}

    async def _cmd_tracer_comment(self, msg: dict) -> dict:
        self.tracer.set_comment(self._tracer_index(msg), clean_text(str(msg.get("text") or "")))
        self._tracer_changed(data=True)
        return {}

    async def _cmd_tracer_config(self, msg: dict) -> dict:
        self.player.config = PlayerConfig.from_patch(self.player.config, msg.get("patch") or {})
        if self.player.config.max_1s != self.settings["tracer_max_1s"]:
            # «Макс. 1 сек» — одна настройка: меню паузы отладчика и «Настройки приложения»
            self.settings = merge_settings(self.settings, {"tracer_max_1s": self.player.config.max_1s})
            self.store.save("settings", self.settings)
            self.broadcast({"type": "settings", "settings": self.settings})
        self._tracer_changed()
        return {}

    def _selection(self, msg: dict) -> list[int] | None:
        sel = msg.get("selection")
        if not sel:
            return None
        found = self.tracer.indices([int(p) for p in sel])
        if not found:
            raise CommandError("Выделенных строк нет в трейсе")
        return found

    async def _cmd_tracer_play(self, msg: dict) -> dict:
        if self.player.config.dest != "monitor":
            self._require_session()
        await self.player.play(self._selection(msg))
        return {}

    async def _cmd_tracer_pause(self, msg: dict) -> dict:
        self.player.pause()
        return {}

    async def _cmd_tracer_stop(self, msg: dict) -> dict:
        self.player.stop()
        return {}

    async def _cmd_tracer_step(self, msg: dict) -> dict:
        if self.player.config.dest != "monitor":
            self._require_session()
        await self.player.step(self._selection(msg))
        return {}

    # ---------------------------------------------------------------- файлы
    def files_dir(self, kind: str) -> tuple[Path, tuple[str, ...]]:
        if kind == "traces":
            return self.traces_dir, TRACE_EXT
        if kind == "lists":
            return self.lists_dir, LIST_EXT
        raise CommandError(f"неизвестный вид файлов: {kind}")

    async def _cmd_files_list(self, msg: dict) -> dict:
        root, exts = self.files_dir(str(msg.get("kind")))
        files = []
        if root.exists():
            for p in root.iterdir():
                if p.is_file() and p.suffix.lower() in exts and not p.name.startswith("."):
                    st = p.stat()
                    files.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
        files.sort(key=lambda f: f["mtime"], reverse=True)
        return {"files": files}

    def _write_list(self, name: str, data: dict) -> None:
        with atomic_text(self.lists_dir / name) as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=1))
        # поле "kind" — для человека; при чтении вид файла проверяется по нужному ключу

    def _write_text(self, name: str, text: str) -> None:
        with atomic_text(self.lists_dir / name) as fh:
            fh.write(text)

    def _read_text(self, name: str) -> str:
        path = self.lists_dir / name
        if not path.exists():
            raise CommandError(f"Файл {name} не существует!")
        raw = path.read_bytes()
        try:
            return raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return raw.decode("cp1251")

    def _read_list(self, name: str) -> dict:
        path = self.lists_dir / name
        if not path.exists():
            raise CommandError(f"Файл {name} не существует!")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            raise CommandError("Неверный формат файла!") from None
        if not isinstance(data, dict):
            raise CommandError("Неверный формат файла!")
        return data
