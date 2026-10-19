"""FastAPI-приложение: WebSocket /ws (двусторонний протокол), REST /api/traces,
отдача собранного фронта. Сессия к прибору создаётся фабрикой на команду connect
(в тестах — FakeSession). Приём агрегируется монитором и раз в ~40 мс (25 Гц)
уходит дельтами; сырой поток батчится тем же тиком."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.can_session import CanSession
from app.monitor import MonitorState
from app.schemas import FrameMsg, frame_to_dict, row_to_dict
from app.trace import TracePlayer, TraceReader, TraceWriter
from app.transmit import Trigger, TransmitManager, TxTask

TRACES_DIR = Path(__file__).resolve().parents[2] / "traces"
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
TICK_SECONDS = 0.04


class Connection:
    def __init__(self, ws: WebSocket, factory: Callable[[], CanSession]) -> None:
        self.ws = ws
        self.factory = factory
        self.session: CanSession | None = None
        self.monitor = MonitorState()
        self.tx: TransmitManager | None = None
        self.writer: TraceWriter | None = None
        self.player_task: asyncio.Task | None = None
        self.loaded_frames: list = []
        self.out: asyncio.Queue[dict] = asyncio.Queue()
        self.bg: list[asyncio.Task] = []
        self.stream_buf: list = []

    async def run(self) -> None:
        await self.ws.accept()
        sender = asyncio.create_task(self._sender())
        try:
            while True:
                raw = await self.ws.receive_text()
                await self._handle(raw)
        except WebSocketDisconnect:
            pass
        finally:
            for t in self.bg:
                t.cancel()
            sender.cancel()
            if self.writer:
                self.writer.close()
            if self.session:
                await self.session.close()

    async def _sender(self) -> None:
        while True:
            msg = await self.out.get()
            await self.ws.send_json(msg)

    def _emit(self, msg: dict) -> None:
        self.out.put_nowait(msg)

    async def _handle(self, raw: str) -> None:
        try:
            cmd = json.loads(raw)
            if not isinstance(cmd, dict) or "type" not in cmd:
                raise ValueError("message needs a 'type'")
            handler = getattr(self, f"_cmd_{cmd['type']}", None)
            if handler is None:
                raise ValueError(f"unknown command type: {cmd['type']}")
            await handler(cmd)
        except Exception as e:  # невалидный ввод не рвёт сокет
            self._emit({"type": "error", "message": str(e)})

    def _ok(self, message: str) -> None:
        self._emit({"type": "status", "connected": self.session is not None,
                    "bus": self.session is not None, "message": message})

    # --- команды ---
    async def _cmd_connect(self, cmd: dict) -> None:
        self.session = self.factory()
        try:
            await self.session.connect()
        except Exception as e:
            self.session = None
            self._emit({"type": "status", "connected": False, "bus": False, "message": str(e)})
            return
        self.tx = TransmitManager(self.session)
        info = await self.session.get_device_info()
        self._emit({"type": "device_info", "info": info})
        self.bg.append(asyncio.create_task(self._reader()))
        self.bg.append(asyncio.create_task(self._ticker()))
        self._ok("connected")

    async def _cmd_disconnect(self, cmd: dict) -> None:
        for t in self.bg:
            t.cancel()
        self.bg.clear()
        if self.session:
            await self.session.close()
        self.session = None
        self._emit({"type": "status", "connected": False, "bus": False, "message": "disconnected"})

    async def _cmd_open_channel(self, cmd: dict) -> None:
        await self.session.open_channel(cmd["channel"], cmd["bitrate"], cmd.get("listen_only", False))
        self._ok("channel opened")

    async def _cmd_set_hw_filter(self, cmd: dict) -> None:
        await self.session.set_hw_filter(
            cmd["channel"], cmd["index"], cmd["can_id"], cmd["mask"], cmd.get("extended", False)
        )
        self._ok("filter set")

    async def _cmd_clear_filters(self, cmd: dict) -> None:
        await self.session.clear_filters(cmd["channel"])
        self._ok("filters cleared")

    async def _cmd_tx_shot(self, cmd: dict) -> None:
        await self.tx.shot(FrameMsg(**cmd["frame"]).to_frame())
        self._ok("tx_shot")

    async def _cmd_tx_add(self, cmd: dict) -> None:
        t = cmd["task"]
        self.tx.add_task(TxTask(id=t["id"], frame=FrameMsg(**t["frame"]).to_frame(),
                                period_ms=t.get("period_ms")))
        self._ok("tx_add")

    async def _cmd_tx_run(self, cmd: dict) -> None:
        await self.tx.run(cmd["id"])
        self._ok("tx_run")

    async def _cmd_tx_stop(self, cmd: dict) -> None:
        self.tx.stop(cmd["id"])
        self._ok("tx_stop")

    async def _cmd_tx_run_all(self, cmd: dict) -> None:
        await self.tx.run_all()
        self._ok("tx_run_all")

    async def _cmd_tx_stop_all(self, cmd: dict) -> None:
        self.tx.stop_all()
        self._ok("tx_stop_all")

    async def _cmd_trigger_add(self, cmd: dict) -> None:
        t = cmd["trigger"]
        self.tx.add_trigger(Trigger(
            match_channel=t["channel"], match_id=t["can_id"],
            match_data=bytes.fromhex(t["data"]), match_mask=bytes.fromhex(t["mask"]),
            action=FrameMsg(**t["action"]).to_frame(),
        ))
        self._ok("trigger_add")

    async def _cmd_record_start(self, cmd: dict) -> None:
        TRACES_DIR.mkdir(parents=True, exist_ok=True)
        name = cmd.get("name") or "trace"
        self.writer = TraceWriter(str(TRACES_DIR / f"{name}.jsonl"))
        self._ok("record_start")

    async def _cmd_record_stop(self, cmd: dict) -> None:
        if self.writer:
            self.writer.close()
            self.writer = None
        self._ok("record_stop")

    async def _cmd_tracer_load(self, cmd: dict) -> None:
        self.loaded_frames = TraceReader(str(TRACES_DIR / cmd["name"])).frames()
        self._ok(f"loaded {len(self.loaded_frames)} frames")

    async def _cmd_tracer_play(self, cmd: dict) -> None:
        to_monitor = cmd.get("to_monitor", False)
        only = cmd.get("only_channel")
        frames = [f for f in self.loaded_frames if only in (None, f.channel)]

        async def sink(f):
            if to_monitor:
                self.monitor.update(f)
            else:
                await self.session.send(f)

        player = TracePlayer(frames)
        self.player_task = asyncio.create_task(
            player.play(sink, speed=cmd.get("speed", 1.0), repeat=cmd.get("repeat", False))
        )
        self._ok("tracer_play")

    async def _cmd_tracer_stop(self, cmd: dict) -> None:
        if self.player_task:
            self.player_task.cancel()
            self.player_task = None
        self._ok("tracer_stop")

    async def _cmd_tracer_step(self, cmd: dict) -> None:
        self._ok("tracer_step")

    async def _cmd_clear(self, cmd: dict) -> None:
        self.monitor.clear()
        self._ok("clear")

    # --- фоновые петли ---
    async def _reader(self) -> None:
        async for f in self.session.frames():
            self.monitor.update(f)
            self.stream_buf.append(f)
            if self.writer:
                self.writer.write(f)
            if self.tx:
                await self.tx.on_frame(f)

    async def _ticker(self) -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            rows = self.monitor.snapshot_delta()
            if rows:
                self._emit({"type": "monitor_delta", "rows": [row_to_dict(r) for r in rows]})
            if self.stream_buf:
                buf, self.stream_buf = self.stream_buf, []
                self._emit({"type": "stream", "frames": [frame_to_dict(f) for f in buf]})


def create_app(session_factory: Callable[[], CanSession]) -> FastAPI:
    app = FastAPI(title="CarBUS for Mac")

    @app.get("/api/traces")
    def list_traces() -> JSONResponse:
        if not TRACES_DIR.exists():
            return JSONResponse([])
        return JSONResponse(sorted(p.name for p in TRACES_DIR.glob("*.jsonl")))

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await Connection(ws, session_factory).run()

    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="static")

    return app
