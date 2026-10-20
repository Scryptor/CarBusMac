"""FastAPI-приложение: WebSocket /ws (протокол v2 поверх общего Hub), REST для
файлов трейсов и списков (загрузка с компьютера / скачивание), отдача собранного
фронта. Сессия к прибору создаётся фабрикой на команду connect (в тестах —
FakeSession, в разработке — демо-источник app.demo).

Сервер слушает только loopback мака, но достучаться до localhost может любая
страница, открытая в том же браузере. Поэтому: Host должен быть loopback-именем
(защита от DNS-rebinding), а WebSocket и изменяющие запросы с чужим Origin
отклоняются — чужой сайт не может ни слать кадры в шину, ни писать файлы."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.can_session import CanSession
from app.hub import CommandError, Hub, safe_name
from app.store import JsonStore

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
DEFAULT_ALLOWED_HOSTS = ("localhost", "127.0.0.1", "::1")
# больше стольких неотправленных сообщений — вкладка не читает сокет (зависла или
# уснула); её отключаем, иначе очередь растёт без предела. Вернётся — получит hello.
MAX_PENDING = 5000


def _hostname(host_header: str) -> str:
    """«localhost:8000» → «localhost», «[::1]:8000» → «::1»."""
    v = host_header.strip().lower()
    if v.startswith("["):
        return v[1:v.index("]")] if "]" in v else v
    return v.rsplit(":", 1)[0] if v.count(":") == 1 else v


class WsClient:
    """Очередь исходящих сообщений одного браузера: хаб не ждёт медленный сокет."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.pump_task: asyncio.Task | None = None
        self.overflow = False

    def send(self, msg: dict) -> None:
        if self.overflow:
            return
        if self.queue.qsize() >= MAX_PENDING:
            self.overflow = True
            while not self.queue.empty():
                self.queue.get_nowait()
            if self.pump_task is not None:
                self.pump_task.cancel()
            asyncio.get_running_loop().create_task(self._close())
            return
        self.queue.put_nowait(msg)

    async def _close(self) -> None:
        try:
            await asyncio.wait_for(self.ws.close(code=1013), timeout=5)
        except Exception:
            pass

    async def pump(self) -> None:
        while True:
            msg = await self.queue.get()
            await self.ws.send_json(msg)


def create_app(
    session_factory: Callable[..., CanSession],
    *,
    data_dir: Path | None = None,
    traces_dir: Path | None = None,
    allowed_hosts: Iterable[str] = DEFAULT_ALLOWED_HOSTS,
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
    allowed = {h.lower() for h in allowed_hosts}

    def host_ok(headers) -> bool:
        return _hostname(headers.get("host", "")) in allowed

    def origin_ok(headers) -> bool:
        origin = headers.get("origin")
        if not origin:
            return True          # не браузер: скрипты, curl, тесты
        try:
            return (urlsplit(origin).hostname or "") in allowed
        except ValueError:
            return False

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if not host_ok(request.headers):
            return PlainTextResponse("Invalid host", status_code=400)
        if request.method not in ("GET", "HEAD", "OPTIONS") and not origin_ok(request.headers):
            return PlainTextResponse("Forbidden origin", status_code=403)
        return await call_next(request)

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        if not host_ok(ws.headers) or not origin_ok(ws.headers):
            await ws.close(code=1008)
            return
        await ws.accept()
        client = WsClient(ws)
        pump = asyncio.create_task(client.pump())
        client.pump_task = pump
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
