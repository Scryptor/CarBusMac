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
import os
import re
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from app.can_session import CanSession
from app.capture import Capture
from app.deskfmt import format_cmt, format_tsk, parse_cmt, parse_tsk
from app.filters import HwFilters, SoftFilters, layout_from_device, range_from_dict, slot_from_dict
from app.models import CanFrame
from app.monitor import MonitorState
from app.schemas import row_to_dict
from app.settings import DEFAULT_SETTINGS, merge_settings
from app.store import JsonStore
from app.tracefmt import TraceDoc, read_trace, write_trace
from app.tracer import PlayerConfig, TracePlayer, TracerDoc, TraceRow
from app.transmit import TransmitManager, task_from_dict

TICK_SECONDS = 0.04
DEFAULT_CLOCK_HZ = 120_000_000   # тактовая CAN у CH32, если прибор её не сообщил
PRESET_BITRATES = (10000, 20000, 33300, 50000, 62500, 83300, 95200, 100000, 125000, 250000,
                   400000, 500000, 800000, 1000000)
TRACE_EXT = (".trc", ".jsonl")
LIST_EXT = (".json", ".cmt", ".tsk")
_NAME_RE = re.compile(r"^[^/\\\x00-\x1f]+$")
MAX_ROWS_PER_REQUEST = 2000


class Client(Protocol):
    def send(self, msg: dict) -> None: ...


class CommandError(ValueError):
    pass


def safe_name(name: str, allowed: tuple[str, ...], default_ext: str | None = None) -> str:
    """Только basename без скрытых файлов и с разрешённым расширением."""
    name = str(name or "").strip()
    if default_ext and not Path(name).suffix:
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
        "channels": [_channel_default(1), _channel_default(2)],
    }


def _channel_default(n: int) -> dict[str, Any]:
    return {"channel": n, "alias": "", "bitrate": 500000, "timing": None, "listen_only": False,
            "terminator": False, "auto_open": n == 1}


def normalize_connection(cfg: dict[str, Any]) -> dict[str, Any]:
    out = {"bridge_host": str(cfg.get("bridge_host") or "").strip(),
           "bridge_port": int(cfg.get("bridge_port") or 0), "channels": []}
    if not out["bridge_host"] or not 0 < out["bridge_port"] < 65536:
        raise CommandError("Неверный адрес моста")
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
    frame = CanFrame(channel=int(d.get("ch", 1)), can_id=can_id, data=data, extended=ext,
                     rtr=bool(d.get("rtr", False)), timestamp=float(d.get("ts", 0.0)))
    return TraceRow(frame, enabled=bool(d.get("enabled", True)), bp=bool(d.get("bp", False)),
                    before_ms=max(0, int(d.get("before_ms", 0))), after_ms=max(0, int(d.get("after_ms", 0))),
                    comment=str(d.get("comment", "")))


class Hub:
    def __init__(
        self,
        factory: Callable[..., CanSession],
        store: JsonStore,
        traces_dir: Path,
        data_dir: Path,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.factory = factory
        self.store = store
        self.traces_dir = Path(traces_dir)
        self.lists_dir = Path(data_dir) / "lists"
        self.clients: set[Client] = set()

        self.settings = merge_settings(DEFAULT_SETTINGS, store.load("settings", {}) or {})
        self.comments: dict[str, str] = dict(store.load("comments", {}) or {})
        self.bitrates: list[dict] = list(store.load("bitrates", []) or [])
        try:
            self.connection = normalize_connection(store.load("connection", None) or default_connection())
        except (CommandError, TypeError, ValueError, KeyError):
            self.connection = default_connection()

        self.session: CanSession | None = None
        self.state = "closed"
        self.message = ""
        self.device_info: dict | None = None
        self.channels: dict[int, dict] = {}

        self.monitor = MonitorState(aggregator=self.settings["aggregator"])
        self.capture = Capture()
        self.capture_rev = 0
        self.tx = TransmitManager(send=self._tx_send, sleep=sleep, on_change=self._tx_changed)
        self.hw = HwFilters(layout_from_device({}))
        self.soft = SoftFilters()
        self._restore_lists()
        self.tracer = TracerDoc()
        self.tracer_rev = 0
        self.player = TracePlayer(self.tracer, send=self._player_send, sleep=sleep,
                                  on_progress=self._player_progress)

        self._reader_task: asyncio.Task | None = None
        self._ticker_task: asyncio.Task | None = None
        self._last_rx_dev: float | None = None
        self._last_rx_mono: float | None = None
        self._connect_mono = time.monotonic()
        self._rx_count = 0
        self._tx_count = 0
        self._sent_tail = 0
        self._sent_counts: dict[str, int] = {}
        self._stats_at = time.monotonic()
        self.logger = None   # фоновое логирование (Task 23)

    # ------------------------------------------------------------ состояние
    def _restore_lists(self) -> None:
        if self.settings["restore_tx_on_start"]:
            try:
                self.tx.load_list(self.store.load("transmit", []) or [])
            except (ValueError, TypeError, KeyError):
                pass
        if self.settings["filter_restore_on_start"]:
            saved = self.store.load("filters", {}) or {}
            self.hw.load_list(saved.get("hw", []))
            self.soft.load_list(saved.get("ranges", []))

    def _status(self) -> dict[str, Any]:
        return {"type": "status", "state": self.state, "message": self.message,
                "device_info": self.device_info,
                "channels": {str(k): v for k, v in sorted(self.channels.items())}}

    def _capture_state(self) -> dict[str, Any]:
        c = self.capture
        return {"type": "capture_state", "recording": c.recording, "count": len(c),
                "duration_s": c.duration_s(), "full": c.full, "rev": self.capture_rev,
                "markers": [{"index": m.index, "label": m.label, "comment": m.comment, "auto": m.auto}
                            for m in c.markers]}

    def _filters_state(self) -> dict[str, Any]:
        return {"type": "filters_state", "hw": self.hw.to_list(),
                "hw_layout": {str(k): v for k, v in self.hw.layout.items()}, "ranges": self.soft.to_list()}

    def _tracer_state(self) -> dict[str, Any]:
        cfg = self.player.config
        return {"type": "tracer_state", "name": self.tracer.name, "modified": self.tracer.modified,
                "count": len(self.tracer.rows), "channels": self.tracer.channels(), "rev": self.tracer_rev,
                "state": self.player.state, "current": self.player.current,
                "config": dict(cfg.__dict__),
                "breakpoints": [i for i, r in enumerate(self.tracer.rows) if r.bp]}

    def hello(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "status": self._status(),
            "settings": self.settings,
            "comments": self.comments,
            "connection": self.connection,
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

    def detach(self, client: Client) -> None:
        self.clients.discard(client)

    async def handle(self, client: Client, raw: str | dict) -> None:
        req_id = None
        try:
            msg = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
                raise CommandError("message needs a 'type'")
            req_id = msg.get("req_id")
            handler = getattr(self, f"_cmd_{msg['type']}", None)
            if handler is None:
                raise CommandError(f"unknown command type: {msg['type']}")
            data = await handler(msg)
            if req_id is not None:
                client.send({"type": "reply", "req_id": req_id, "ok": True, "data": data})
        except Exception as e:   # невалидный ввод не рвёт сокет
            text = str(e) or e.__class__.__name__
            if req_id is not None:
                client.send({"type": "reply", "req_id": req_id, "ok": False, "error": text})
            else:
                client.send({"type": "error", "message": text})

    async def shutdown(self) -> None:
        self.tx.shutdown()
        self.player.stop()
        for t in (self._reader_task, self._ticker_task):
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
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        self.tx.pause_all()
        self.player.stop()
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
        self.session = None
        self.channels = {}

    async def _cmd_connect(self, msg: dict) -> dict:
        cfg = normalize_connection(msg.get("config") or {})
        self.connection = cfg
        self.store.save("connection", cfg)
        await self._close_session()
        self.state, self.message = "opening", ""
        self.broadcast(self._status())
        session = self.factory(cfg["bridge_host"], cfg["bridge_port"])
        try:
            await session.connect()
            info = await session.get_device_info()
        except Exception as e:
            self.state, self.message = "error", str(e)
            self.broadcast(self._status())
            raise CommandError(str(e)) from None
        self.session = session
        self.device_info = info
        self._connect_mono = time.monotonic()
        self._last_rx_dev = self._last_rx_mono = None
        layout = layout_from_device(info)
        if layout != self.hw.layout:
            old = self.hw.to_list()
            self.hw = HwFilters(layout)
            self.hw.load_list(old)
        for ch in cfg["channels"]:
            await self._open_channel(ch)
        for slot in self.hw.slots:
            if slot.enabled and self.channels.get(slot.channel, {}).get("open"):
                await self._apply_slot(slot)
        self._reader_task = asyncio.create_task(self._reader(session))
        self.state = "opened"
        self.broadcast(self._status())
        self.broadcast(self._filters_state())
        return {}

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
            self.state, self.message = "error", f"RX stopped: {e}"
            self.broadcast(self._status())

    async def _on_rx(self, f: CanFrame) -> None:
        if f.ts_source == "device":
            self._last_rx_dev, self._last_rx_mono = f.timestamp, time.monotonic()
        if not self.soft.accept(f):
            return
        self._rx_count += 1
        self.monitor.update(f)
        self.capture.append(f)
        if self.logger is not None:
            self.logger.write(f)
        await self.tx.on_frame(f)
        self.player.notify_rx()

    def _now_device(self) -> tuple[float, str]:
        now = time.monotonic()
        if self._last_rx_dev is not None and self._last_rx_mono is not None:
            return self._last_rx_dev + (now - self._last_rx_mono), "device"
        return now - self._connect_mono, "arrival"

    async def _tx_send(self, frame: CanFrame) -> None:
        await self._require_session().send(frame)
        ts, src = self._now_device()
        out = replace(frame, timestamp=ts, ts_source=src, direction="tx")
        self._tx_count += 1
        self.capture.append(out)
        if self.logger is not None and self.settings["log_record_tx"]:
            self.logger.write(out)

    # ---------------------------------------------------------------- тикер
    async def _ticker(self) -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                self._tick()
            except Exception as e:   # тикер не должен умирать молча
                self.broadcast({"type": "error", "message": f"tick: {e}"})

    def _tick(self) -> None:
        rows = self.monitor.snapshot_delta()
        if rows:
            self.broadcast({"type": "monitor_delta", "rows": [row_to_dict(r) for r in rows]})
        n = len(self.capture)
        if n != self._sent_tail:
            start = max(0, n - 100)
            self.broadcast({"type": "capture_tail", "count": n, "duration_s": self.capture.duration_s(),
                            "rev": self.capture_rev, "start": start, "rows": self.capture.rows(start, n - start)})
            if self.capture.full:
                self.broadcast(self._capture_state())
            self._sent_tail = n
        now = time.monotonic()
        if now - self._stats_at >= 0.25:
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
        key = _comment_key(msg["id"], bool(msg.get("ext", False)))
        text = str(msg.get("text") or "").strip()
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
        name = safe_name(msg.get("name"), LIST_EXT, ext)
        if name.lower().endswith(".cmt"):
            self._write_text(name, format_cmt(self.comments))
        else:
            self._write_list(name, {"comments": self.comments})
        return {"name": name}

    async def _cmd_comments_load(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), LIST_EXT, ".cmt")
        if name.lower().endswith(".cmt"):
            loaded = parse_cmt(self._read_text(name))
        else:
            data = self._read_list(name)
            loaded = {str(k): str(v) for k, v in (data.get("comments") or {}).items()}
        self.comments = {**self.comments, **loaded} if msg.get("append") else loaded
        self._comments_changed()
        return {}

    async def _cmd_settings_set(self, msg: dict) -> dict:
        before = self.settings
        self.settings = merge_settings(self.settings, msg.get("patch") or {})
        if self.settings["aggregator"] != before["aggregator"]:
            self.monitor.set_aggregator(self.settings["aggregator"])
        self.store.save("settings", self.settings)
        self.broadcast({"type": "settings", "settings": self.settings})
        return {"settings": self.settings}

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
                          "sample_pct": float(b.get("sample_pct") or 75.0),
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
        self.capture.start() if msg.get("on") else self.capture.pause()
        self._capture_changed()
        return {}

    async def _cmd_capture_clear(self, msg: dict) -> dict:
        self.capture.clear()
        self._capture_changed(reset=True)
        return {}

    async def _cmd_capture_rows(self, msg: dict) -> dict:
        count = min(int(msg.get("count", 100)), MAX_ROWS_PER_REQUEST)
        return {"rows": self.capture.rows(int(msg.get("start", 0)), count), "rev": self.capture_rev}

    async def _cmd_capture_marker(self, msg: dict) -> dict:
        label = str(msg.get("label") or "")
        if msg.get("auto") or not label:
            label = f"#{sum(1 for m in self.capture.markers if m.auto) + 1}"
        m = self.capture.add_marker(label, str(msg.get("comment") or ""), auto=bool(msg.get("auto")))
        self._capture_changed()
        return {"index": m.index, "label": m.label}

    def _row_comments(self, frames: list[CanFrame]) -> dict[int, str]:
        out = {}
        for i, f in enumerate(frames):
            text = self.comments.get(_comment_key(f.can_id, f.extended))
            if text:
                out[i] = text
        return out

    async def _cmd_capture_save(self, msg: dict) -> dict:
        ext = ".jsonl" if msg.get("format") == "jsonl" else ".trc"
        name = safe_name(msg.get("name"), TRACE_EXT, ext)
        frames = self.capture.frames()
        meta = {k: v for k, v in self.settings["log_meta"].items() if v}
        doc = TraceDoc(frames=frames, markers=list(self.capture.markers),
                       comments=self._row_comments(frames), meta=meta)
        self.traces_dir.mkdir(parents=True, exist_ok=True)
        write_trace(self.traces_dir / name, doc, local_time=datetime.now())
        self.broadcast({"type": "toast", "level": "info", "message": "Поток данных сохранён!"})
        return {"name": name}

    async def _cmd_capture_load(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), TRACE_EXT)
        doc = read_trace(self.traces_dir / name)
        self.capture.load(doc.frames, doc.markers)
        self._capture_changed(reset=True)
        return {"count": len(doc.frames), "skipped": doc.skipped}

    async def _cmd_capture_to_tracer(self, msg: dict) -> dict:
        frames = self.capture.frames()
        self.player.stop()
        self.tracer.load(TraceDoc(frames=frames, markers=list(self.capture.markers),
                                  comments=self._row_comments(frames)), None)
        self._tracer_changed(reset=True)
        return {"count": len(frames)}

    # ------------------------------------------------------------- передача
    def _tx_changed(self) -> None:
        self.store.save("transmit", self.tx.to_list())
        self.broadcast({"type": "tx_state", "tasks": self.tx.to_list()})

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
        self.tx.start(str(msg["id"]))
        return {}

    async def _cmd_tx_pause(self, msg: dict) -> dict:
        self.tx.pause(str(msg["id"]))
        return {}

    async def _cmd_tx_start_all(self, msg: dict) -> dict:
        self._require_session()
        self.tx.start_all()
        return {}

    async def _cmd_tx_pause_all(self, msg: dict) -> dict:
        self.tx.pause_all()
        return {}

    async def _cmd_tx_reset(self, msg: dict) -> dict:
        self.tx.reset(msg.get("id"))
        return {}

    async def _cmd_tx_save(self, msg: dict) -> dict:
        ext = ".json" if msg.get("format") == "json" else ".tsk"
        name = safe_name(msg.get("name"), LIST_EXT, ext)
        if name.lower().endswith(".tsk"):
            self._write_text(name, format_tsk(self.tx.to_list()))
        else:
            self._write_list(name, {"transmit": self.tx.to_list()})
        return {"name": name}

    async def _cmd_tx_load(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), LIST_EXT, ".tsk")
        if name.lower().endswith(".tsk"):
            self.tx.load_list(parse_tsk(self._read_text(name)))
        else:
            self.tx.load_list(self._read_list(name).get("transmit") or [])
        return {"count": len(self.tx.tasks)}

    # -------------------------------------------------------------- фильтры
    def _filters_changed(self) -> None:
        self.store.save("filters", {"hw": self.hw.to_list(), "ranges": self.soft.to_list()})
        self.broadcast(self._filters_state())

    async def _apply_slot(self, slot) -> None:
        if self.session is None:
            return
        if slot.enabled:
            await self.session.set_hw_filter(slot.channel, slot.index, slot.can_id, slot.mask, slot.ext)
        else:
            await self.session.clear_hw_filter(slot.channel, slot.index)

    async def _cmd_hw_set(self, msg: dict) -> dict:
        slot = slot_from_dict(msg.get("slot") or {})
        self.hw.set(slot)
        await self._apply_slot(slot)
        self._filters_changed()
        return {}

    async def _cmd_filters_add_id(self, msg: dict) -> dict:
        ch, ext = int(msg["channel"]), bool(msg.get("ext", False))
        slot = self.hw.first_free(ch)
        if slot is None:
            raise CommandError("Не могу добавить фильтр.")
        slot = replace(slot, enabled=self.settings["filter_new_active"], can_id=int(msg["id"]),
                       mask=0x1FFFFFFF if ext else 0x7FF, ext=ext)
        self.hw.set(slot)
        await self._apply_slot(slot)
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
        name = safe_name(msg.get("name"), LIST_EXT, ".json")
        self._write_list(name, {"hw": self.hw.to_list(), "ranges": self.soft.to_list()})
        return {"name": name}

    async def _cmd_hw_load(self, msg: dict) -> dict:
        data = self._read_list(safe_name(msg.get("name"), LIST_EXT, ".json"))
        self.hw.load_list(data.get("hw") or [])
        self.soft.load_list(data.get("ranges") or [])
        for slot in self.hw.slots:
            await self._apply_slot(slot)
        self._filters_changed()
        return {}

    # ------------------------------------------------------------- отладчик
    def _tracer_changed(self, reset: bool = False) -> None:
        if reset:
            self.tracer_rev += 1
        self.broadcast(self._tracer_state())

    def _player_progress(self, current: int | None, state: str) -> None:
        self.broadcast({"type": "tracer_progress", "current": current, "state": state})

    async def _player_send(self, frame: CanFrame, target: str) -> None:
        if target == "monitor":
            ts, src = self._now_device()
            self.monitor.update(replace(frame, timestamp=ts, ts_source=src, direction="rx"))
        else:
            await self._tx_send(frame)

    async def _cmd_tracer_new(self, msg: dict) -> dict:
        self.player.stop()
        self.tracer.load(TraceDoc(frames=[]), None)
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_open(self, msg: dict) -> dict:
        name = safe_name(msg.get("name"), TRACE_EXT)
        doc = read_trace(self.traces_dir / name)
        self.player.stop()
        self.tracer.load(doc, name)
        self._tracer_changed(reset=True)
        return {"count": len(doc.frames), "skipped": doc.skipped}

    async def _cmd_tracer_save(self, msg: dict) -> dict:
        raw = msg.get("name") or self.tracer.name
        if not raw:
            raise CommandError("Укажите имя файла")
        ext = ".jsonl" if msg.get("format") == "jsonl" else ".trc"
        name = safe_name(raw, TRACE_EXT, ext)
        self.traces_dir.mkdir(parents=True, exist_ok=True)
        write_trace(self.traces_dir / name, self.tracer.to_trace_doc())
        self.tracer.name = name
        self.tracer.modified = False
        self._tracer_changed()
        return {"name": name}

    async def _cmd_tracer_rows(self, msg: dict) -> dict:
        count = min(int(msg.get("count", 100)), MAX_ROWS_PER_REQUEST)
        return {"rows": self.tracer.rows_view(int(msg.get("start", 0)), count), "rev": self.tracer_rev}

    async def _cmd_tracer_ids(self, msg: dict) -> dict:
        return {"ids": self.tracer.ids()}

    async def _cmd_tracer_ids_set(self, msg: dict) -> dict:
        keys = [(int(k[0]), int(k[1]), bool(k[2])) for k in msg.get("keys") or []]
        self.tracer.set_ids_enabled(keys, bool(msg.get("enabled")))
        self._tracer_changed()
        return {"ids": self.tracer.ids()}

    async def _cmd_tracer_row_add(self, msg: dict) -> dict:
        idx = self.tracer.add(row_from_dict(msg.get("row") or {}), msg.get("index"))
        self._tracer_changed(reset=True)
        return {"index": idx}

    async def _cmd_tracer_row_edit(self, msg: dict) -> dict:
        self.tracer.edit(int(msg["index"]), row_from_dict(msg.get("row") or {}))
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_rows_delete(self, msg: dict) -> dict:
        self.tracer.delete([int(i) for i in msg.get("indices") or []])
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_rows_enable(self, msg: dict) -> dict:
        on = bool(msg.get("enabled"))
        if msg.get("key") is not None:
            k = msg["key"]
            self.tracer.set_enabled_by_id((int(k[0]), int(k[1]), bool(k[2])), on)
        else:
            self.tracer.set_enabled([int(i) for i in msg.get("indices") or []], on)
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_bp(self, msg: dict) -> dict:
        idx = int(msg["index"])
        on = msg.get("on")
        self.tracer.set_bp(idx, (not self.tracer.rows[idx].bp) if on is None else bool(on))
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_bp_clear(self, msg: dict) -> dict:
        for r in self.tracer.rows:
            r.bp = False
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_comment(self, msg: dict) -> dict:
        self.tracer.set_comment(int(msg["index"]), str(msg.get("text") or ""))
        self._tracer_changed(reset=True)
        return {}

    async def _cmd_tracer_config(self, msg: dict) -> dict:
        self.player.config = PlayerConfig.from_patch(self.player.config, msg.get("patch") or {})
        self._tracer_changed()
        return {}

    async def _cmd_tracer_play(self, msg: dict) -> dict:
        if self.player.config.dest != "monitor":
            self._require_session()
        sel = msg.get("selection")
        await self.player.play([int(i) for i in sel] if sel else None)
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
        await self.player.step()
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
        self.lists_dir.mkdir(parents=True, exist_ok=True)
        (self.lists_dir / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    def _write_text(self, name: str, text: str) -> None:
        self.lists_dir.mkdir(parents=True, exist_ok=True)
        (self.lists_dir / name).write_text(text, encoding="utf-8", newline="")

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
