"""REST файлов: загрузка с компьютера, скачивание, защита от обхода каталога."""
import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.can_session import FakeSession
from app.server import MAX_PENDING, WsClient, create_app

HOSTS = ("testserver", "localhost", "127.0.0.1", "::1")


def _client(tmp_path):
    app = create_app(lambda h=None, p=None: FakeSession(), data_dir=tmp_path / "data",
                     traces_dir=tmp_path / "traces", allowed_hosts=HOSTS)
    return TestClient(app)


def test_files_upload_download_rejects_traversal(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/files/traces?name=../x.trc", content=b"x").status_code == 400
        assert c.post("/api/files/traces?name=run.exe", content=b"x").status_code == 400
        r = c.post("/api/files/traces?name=a.trc", content=b"@ TEXT @ 3 @")
        assert r.status_code == 200 and r.json() == {"name": "a.trc"}
        assert (tmp_path / "traces" / "a.trc").read_bytes() == b"@ TEXT @ 3 @"
        got = c.get("/api/files/traces/a.trc")
        assert got.status_code == 200 and got.content == b"@ TEXT @ 3 @"
        assert c.get("/api/files/traces/..%2Fsecret.trc").status_code in (400, 404)
        assert c.get("/api/files/nope/a.trc").status_code == 404


def test_lists_kind_accepts_json(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/files/lists?name=tx.json", content=b"[]").status_code == 200
        assert (tmp_path / "data" / "lists" / "tx.json").exists()


def test_foreign_web_pages_cannot_drive_the_tool(tmp_path):
    """Любая открытая в браузере страница может стучаться на localhost: чужой Origin
    не получает ни WebSocket (а с ним — передачу в шину), ни загрузку файлов."""
    with _client(tmp_path) as c:
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        assert c.post("/api/files/traces?name=a.trc", content=b"x",
                      headers={"origin": "https://evil.example"}).status_code == 403
        assert not (tmp_path / "traces" / "a.trc").exists()
        with c.websocket_connect("/ws", headers={"origin": "http://localhost:8000"}) as ws:
            assert ws.receive_json()["type"] == "hello"
        assert c.post("/api/files/traces?name=b.trc", content=b"x",
                      headers={"origin": "http://127.0.0.1:8000"}).status_code == 200


def test_dns_rebinding_host_is_rejected(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/files/traces?name=a.trc", content=b"secret").status_code == 200
        assert c.get("/api/files/traces/a.trc", headers={"host": "evil.example:8000"}).status_code == 400
        assert c.get("/api/files/traces/a.trc", headers={"host": "localhost:8000"}).status_code == 200


def test_default_hosts_are_loopback_only(tmp_path):
    app = create_app(lambda h=None, p=None: FakeSession(), data_dir=tmp_path / "data", traces_dir=tmp_path / "traces")
    with TestClient(app, base_url="http://localhost:8000") as c:
        assert c.get("/api/files/traces/none.trc").status_code == 404
    with TestClient(app) as c:                 # Host: testserver
        assert c.get("/api/files/traces/none.trc").status_code == 400


def test_stuck_client_queue_is_bounded():
    class StuckWs:
        async def send_json(self, msg):
            await asyncio.Event().wait()

        async def close(self, code=1000):
            pass

    async def run():
        c = WsClient(StuckWs())
        c.pump_task = asyncio.create_task(c.pump())
        for i in range(MAX_PENDING + 50):
            c.send({"n": i})
        await asyncio.sleep(0)
        assert c.overflow and c.queue.qsize() == 0
        assert c.pump_task.cancelled() or c.pump_task.done()

    asyncio.run(run())


def test_importing_server_does_not_touch_the_data_dir(tmp_path):
    """Тесты и `python -m app.demo --data X` импортируют модуль — настоящий ./data
    при этом не читается и не переписывается."""
    import os
    import subprocess
    import sys
    from pathlib import Path
    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "CARBUS_DATA": str(tmp_path / "data"), "CARBUS_TRACES": str(tmp_path / "traces")}
    subprocess.run([sys.executable, "-c", "import app.server, app.demo"], cwd=backend, env=env, check=True)
    assert not (tmp_path / "data").exists()
    out = subprocess.run([sys.executable, "-c", "from app.server import app; print(type(app).__name__)"],
                         cwd=backend, env=env, check=True, capture_output=True, text=True)
    assert out.stdout.strip() == "FastAPI"


def test_binary_ws_frame_does_not_drop_the_socket(tmp_path):
    with _client(tmp_path) as c, c.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_bytes(b"\x00\x01")
        err = ws.receive_json()
        while err.get("type") != "error":
            err = ws.receive_json()
        ws.send_json({"type": "files_list", "kind": "traces", "req_id": 5})
        r = ws.receive_json()
        while r.get("type") != "reply":
            r = ws.receive_json()
        assert r["ok"] is True
