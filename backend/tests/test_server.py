"""REST файлов: загрузка с компьютера, скачивание, защита от обхода каталога."""
from fastapi.testclient import TestClient

from app.can_session import FakeSession
from app.server import create_app


def _client(tmp_path):
    app = create_app(lambda h=None, p=None: FakeSession(), data_dir=tmp_path / "data",
                     traces_dir=tmp_path / "traces")
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
