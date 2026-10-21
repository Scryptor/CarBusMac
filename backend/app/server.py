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
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Awaitable, Callable, Iterable
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.can_session import CanSession
from app.hub import CommandError, Hub, safe_name
from app.logger import recover_parts
from app.store import JsonStore
from app.tracefmt import write_bytes_atomic

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
    discover: Callable[[dict], Awaitable[dict]] | None = None,
) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("CARBUS_DATA") or REPO_ROOT / "data")
    traces_dir = Path(traces_dir or os.environ.get("CARBUS_TRACES") or REPO_ROOT / "traces")
    hub = Hub(session_factory, JsonStore(data_dir), traces_dir=traces_dir, data_dir=data_dir, discover=discover)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # фоновый лог, брошенный при сбое прошлого запуска (.trc.part), собрать в .trc
        await asyncio.to_thread(recover_parts, traces_dir, time.time())
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
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                text = msg.get("text")
                if text is None:                  # бинарный кадр — протокол только текстовый
                    client.send({"type": "error", "message": "ожидается текстовое сообщение JSON"})
                    continue
                await hub.handle(client, text)
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
        # во временный файл и замена: оборванная загрузка не портит старый файл
        await asyncio.to_thread(write_bytes_atomic, path, body)
        return JSONResponse({"name": path.name})

    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="static")

    return app


def default_session_factory(cfg: dict | None = None, device: dict | None = None) -> CanSession:
    """Боевая фабрика для uvicorn: CarbusSession к прибору, выбранному в app/devices.py —
    напрямую в USB-порт (виден бэкенду) или через мост по адресу из «Настроек устройства»
    (по умолчанию — env CARBUS_BRIDGE, host.docker.internal:7000). carbus-lib импортируется
    лениво."""
    from app.carbus_session import CarbusSession

    if device and device.get("source") == "usb":
        return CarbusSession.usb(device["path"])
    if cfg:
        host, port = str(cfg["bridge_host"]), int(cfg["bridge_port"])
    else:
        host, _, p = os.environ.get("CARBUS_BRIDGE", "host.docker.internal:7000").partition(":")
        port = int(p or "7000")
    return CarbusSession(host, port, (device or {}).get("path", ""))


async def default_discover(cfg: dict) -> dict:
    from app.devices import discover

    return await discover(cfg)


def __getattr__(name: str):
    """Точка входа uvicorn: `uvicorn app.server:app`. Приложение создаётся при первом
    обращении к `app`, а не при импорте модуля: импорт (тесты, `python -m app.demo
    --data …`) не должен читать и переписывать настоящую папку ./data."""
    if name == "app":
        application = create_app(default_session_factory, discover=default_discover)
        globals()["app"] = application
        return application
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
