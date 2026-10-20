"""FastAPI-приложение: WebSocket /ws (протокол v2 поверх общего Hub), REST для
файлов трейсов и списков (загрузка с компьютера / скачивание), отдача собранного
фронта. Сессия к прибору создаётся фабрикой на команду connect (в тестах —
FakeSession, в разработке — демо-источник app.demo)."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.can_session import CanSession
from app.hub import CommandError, Hub, safe_name
from app.store import JsonStore

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
MAX_UPLOAD_BYTES = 256 * 1024 * 1024


class WsClient:
    """Очередь исходящих сообщений одного браузера: хаб не ждёт медленный сокет."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict] = asyncio.Queue()

    def send(self, msg: dict) -> None:
        self.queue.put_nowait(msg)

    async def pump(self) -> None:
        while True:
            msg = await self.queue.get()
            await self.ws.send_json(msg)


def create_app(
    session_factory: Callable[..., CanSession],
    *,
    data_dir: Path | None = None,
    traces_dir: Path | None = None,
) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("CARBUS_DATA") or REPO_ROOT / "data")
    traces_dir = Path(traces_dir or os.environ.get("CARBUS_TRACES") or REPO_ROOT / "traces")
    hub = Hub(session_factory, JsonStore(data_dir), traces_dir=traces_dir, data_dir=data_dir)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await hub.shutdown()

    app = FastAPI(title="CarBUS for Mac", lifespan=lifespan)
    app.state.hub = hub

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        client = WsClient(ws)
        pump = asyncio.create_task(client.pump())
        await hub.attach(client)
        try:
            while True:
                await hub.handle(client, await ws.receive_text())
        except WebSocketDisconnect:
            pass
        finally:
            hub.detach(client)
            pump.cancel()

    def _resolve(kind: str, name: str) -> Path:
        try:
            root, exts = hub.files_dir(kind)
        except CommandError:
            raise HTTPException(404, "unknown kind") from None
        try:
            return root / safe_name(name, exts)
        except CommandError as e:
            raise HTTPException(400, str(e)) from None

    @app.get("/api/files/{kind}/{name}")
    def download(kind: str, name: str) -> FileResponse:
        path = _resolve(kind, name)
        if not path.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(path, filename=path.name)

    @app.post("/api/files/{kind}")
    async def upload(kind: str, name: str, request: Request) -> JSONResponse:
        path = _resolve(kind, name)
        body = await request.body()
        if len(body) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "file too large")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return JSONResponse({"name": path.name})

    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="static")

    return app


def default_session_factory(host: str | None = None, port: int | None = None) -> CanSession:
    """Боевая фабрика для uvicorn: CarbusSession к мосту. Хост/порт берутся из команды
    connect (диалог подключения в UI), иначе — из env CARBUS_BRIDGE
    (по умолчанию host.docker.internal:7000). carbus-lib импортируется лениво."""
    from app.carbus_session import CarbusSession

    if host and port:
        return CarbusSession(str(host), int(port))
    target = os.environ.get("CARBUS_BRIDGE", "host.docker.internal:7000")
    h, _, p = target.partition(":")
    return CarbusSession(h, int(p or "7000"))


# Точка входа для uvicorn: `uvicorn app.server:app`
app = create_app(default_session_factory)
