"""Бэкенд программы для мака (CarBUS.app) — без Docker и без моста.

Окно программы запускает

    python -m app.desktop --port 47800 --data <папка> --traces <папка> --exit-with-parent <PID окна>

Сервер слушает только 127.0.0.1; прибор ищется на своих USB-портах, мост выключен (в окне нет ни
моста, ни Docker). С --exit-with-parent бэкенд завершается сам, когда окно пропало (убито,
упало): иначе он так и держал бы USB-порт прибора. PID окна передаётся явно: окно могут убить,
пока Python ещё грузится, — тогда родитель уже другой, и бэкенд уходит сразу."""
from __future__ import annotations

import argparse
import os
import signal
import threading
import time
from pathlib import Path
from typing import Callable

from app.can_session import CanSession
from app.carbus_session import CarbusSession
from app.devices import discover

DESKTOP_PORT = 47800
NO_DEVICE = "CAN-Hacker не найден. Подключите его к USB и нажмите «Подключиться» ещё раз."


async def desktop_discover(cfg: dict) -> dict:
    return await discover(cfg, listing=None)


def desktop_session_factory(cfg: dict | None = None, device: dict | None = None) -> CanSession:
    if device and device.get("source") == "usb":
        return CarbusSession.usb(device["path"])
    raise ConnectionError(NO_DEVICE)


def watch_parent(ppid: int, on_gone: Callable[[], None], *, interval: float = 1.0,
                 getppid: Callable[[], int] = os.getppid) -> threading.Thread:
    """Фоновый поток: как только родитель сменился (окно убито — нас подобрал launchd), один раз
    вызвать on_gone."""
    def run() -> None:
        while getppid() == ppid:
            time.sleep(interval)
        on_gone()

    t = threading.Thread(target=run, name="watch-parent", daemon=True)
    t.start()
    return t


def leave() -> None:
    """Окна нет: штатная остановка (SIGTERM — uvicorn закроет сервер и прибор); зависла — через
    5 с выйти принудительно."""
    timer = threading.Timer(5, os._exit, args=(0,))
    timer.daemon = True
    timer.start()
    os.kill(os.getpid(), signal.SIGTERM)


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    from app.server import create_app

    ap = argparse.ArgumentParser(description="CarBUS for Mac — бэкенд программы для мака")
    ap.add_argument("--port", type=int, default=DESKTOP_PORT)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--traces", type=Path, required=True)
    ap.add_argument("--exit-with-parent", type=int, metavar="PID", help="завершиться, когда окно с этим PID пропало")
    args = ap.parse_args(argv)
    for folder in (args.data, args.traces):
        folder.mkdir(parents=True, exist_ok=True)
    app = create_app(desktop_session_factory, data_dir=args.data, traces_dir=args.traces, discover=desktop_discover)
    if args.exit_with_parent is not None:
        watch_parent(args.exit_with_parent, leave)
    # открытый WebSocket убитого окна не должен держать остановку
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
