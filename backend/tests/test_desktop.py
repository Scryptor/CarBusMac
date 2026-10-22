"""Бэкенд программы для мака (app.desktop): мост выключен, прибор — только свой USB, бэкенд
уходит вместе с окном."""
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import websockets

from app import desktop
from app.desktop import NO_DEVICE, desktop_session_factory, watch_parent

BACKEND = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(BACKEND)}


def test_factory_opens_usb_device(monkeypatch):
    opened = []

    class FakeSession:
        @classmethod
        def usb(cls, path):
            opened.append(path)
            return "session"

    monkeypatch.setattr(desktop, "CarbusSession", FakeSession)
    assert desktop_session_factory({}, {"source": "usb", "path": "/dev/cu.x"}) == "session"
    assert opened == ["/dev/cu.x"]


@pytest.mark.parametrize("device", [None, {"source": "bridge", "path": "/dev/cu.x"}])
def test_factory_without_usb_device_asks_for_usb(device):
    with pytest.raises(ConnectionError) as e:
        desktop_session_factory({}, device)
    assert str(e.value) == NO_DEVICE and "USB" in NO_DEVICE
    for word in ("Мост", "мост", "Docker", "run-bridge"):
        assert word not in NO_DEVICE


def test_watch_parent_fires_once_when_parent_changes():
    seq = iter([100, 100, 1] + [1] * 1000)
    fired = []
    t = watch_parent(100, lambda: fired.append(1), interval=0.01, getppid=lambda: next(seq))
    t.join(1.0)
    assert fired == [1] and not t.is_alive()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_port(port: int, timeout: float = 20) -> None:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return
        except OSError:
            time.sleep(0.1)
    raise AssertionError(f"бэкенд не слушает {port}")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def desktop_cmd(port: int, tmp_path: Path, *extra: str) -> list[str]:
    return [sys.executable, "-m", "app.desktop", "--port", str(port),
            "--data", str(tmp_path / "data"), "--traces", str(tmp_path / "traces"), *extra]


def test_desktop_exits_when_parent_dies(tmp_path):
    port = free_port()
    # посредник вместо окна: запускает бэкенд и ждёт; его убиваем — бэкенд должен уйти сам
    middle = subprocess.Popen(
        [sys.executable, "-c", "import subprocess, sys, time; p = subprocess.Popen(sys.argv[1:]); "
         "print(p.pid, flush=True); time.sleep(600)", *desktop_cmd(port, tmp_path, "--exit-with-parent")],
        cwd=BACKEND, env=ENV, stdout=subprocess.PIPE, text=True)
    child = int(middle.stdout.readline())
    try:
        wait_port(port)
        middle.kill()
        middle.wait()
        t0 = time.monotonic()
        while time.monotonic() - t0 < 5 and alive(child):
            time.sleep(0.1)
        assert not alive(child), "бэкенд пережил окно"
    finally:
        if alive(child):
            os.kill(child, signal.SIGKILL)


async def test_desktop_serves_without_bridge(tmp_path):
    port = free_port()
    p = subprocess.Popen(desktop_cmd(port, tmp_path), cwd=BACKEND, env=ENV)
    try:
        await asyncio.to_thread(wait_port, port)
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
            await ws.send(json.dumps({"type": "devices_scan", "req_id": 1}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if m.get("type") == "reply" and m.get("req_id") == 1:
                    break
        assert m["ok"] and m["data"]["bridge"]["state"] == "off"
        assert (tmp_path / "data").is_dir() and (tmp_path / "traces").is_dir()
    finally:
        p.terminate()
        p.wait(10)
