"""Протокол WS v2 через настоящий FastAPI-app и TestClient: hello-снапшот, ответы
по req_id, переживание переподключения, конвейер приёма и файлы трейсов."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.can_session import FakeSession
from app.models import CanFrame
from app.server import create_app

INFO = {"hardware_name": "HW_CH32", "firmware_version": "2.2.3.57", "serial_int": 6950,
        "channel_types": {1: "CAN", 2: "CAN", 3: "LIN"}, "channel_features": {1: {"terminator": True}},
        "channel_frequencies": {1: 120_000_000}, "filters_info": [{"channel": 1, "size": 4}, {"channel": 2, "size": 4}]}


class Env:
    def __init__(self, tmp_path, fail_connect=False, raise_on_frames=None):
        self.sessions: list[FakeSession] = []
        self.calls: list[tuple] = []

        def factory(host=None, port=None):
            self.calls.append((host, port))
            s = FakeSession(info=INFO, fail_connect=fail_connect, raise_on_frames=raise_on_frames)
            self.sessions.append(s)
            return s

        self.app = create_app(factory, data_dir=tmp_path / "data", traces_dir=tmp_path / "traces")
        self.traces = tmp_path / "traces"
        self.data = tmp_path / "data"


_seen: dict[int, list] = {}


def recv_until(ws, pred, limit=400):
    """Ищет сообщение сначала среди уже принятых (события приходят и до ответа на
    команду), потом читает сокет. Найденное из буфера удаляется."""
    buf = _seen.setdefault(id(ws), [])
    for i, m in enumerate(buf):
        if pred(m):
            return buf.pop(i)
    for _ in range(limit):
        m = ws.receive_json()
        if pred(m):
            return m
        buf.append(m)
    raise AssertionError("message not received")


_seq = [0]


def call(ws, **cmd):
    _seq[0] += 1
    rid = _seq[0]
    ws.send_json({**cmd, "req_id": rid})
    return recv_until(ws, lambda m: m.get("type") == "reply" and m.get("req_id") == rid)


CONNECT = {"bridge_host": "127.0.0.1", "bridge_port": 7000, "channels": [
    {"channel": 1, "alias": "Кузов", "bitrate": 500000, "timing": None, "listen_only": True,
     "terminator": True, "auto_open": True},
    {"channel": 2, "alias": "", "bitrate": 125000, "timing": None, "listen_only": False,
     "terminator": False, "auto_open": False}]}


def connect(ws):
    r = call(ws, type="connect", config=CONNECT)
    assert r["ok"], r
    return r


def test_hello_snapshot_on_attach(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        for k in ("status", "settings", "comments", "connection", "bitrates", "monitor", "capture", "tx",
                  "filters", "tracer"):
            assert k in hello
        assert hello["status"]["state"] == "closed" and hello["settings"]["mark_hold_ms"] == 2000


def test_reply_matches_req_id_and_settings_broadcast(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        r = call(ws, type="settings_set", patch={"theme": "dark", "mark_hold_ms": 99999})
        assert r["ok"] and r["data"]["settings"]["mark_hold_ms"] == 10000


def test_bad_command_replies_error(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="nope")["ok"] is False
        bad = call(ws, type="tx_upsert", task={"id": "t", "can_id": 0x800})
        assert bad["ok"] is False and "ID" in bad["error"]
        ws.send_text("{not json")
        assert recv_until(ws, lambda m: m["type"] == "error")
        assert call(ws, type="files_list", kind="traces")["ok"] is True   # сокет жив


def test_connect_opens_channels_terminator_and_reports_status(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        st = recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "opened")
        s = env.sessions[-1]
        assert env.calls[-1] == ("127.0.0.1", 7000)
        assert s.channels == [(1, 500000, True)] and s.terminators == {1: True}
        assert st["channels"]["1"]["open"] and not st["channels"]["2"]["open"]
        assert st["device_info"]["hardware_name"] == "HW_CH32"
        flt = recv_until(ws, lambda m: m["type"] == "filters_state")
        assert flt["hw_layout"] == {"1": 4, "2": 4} and len(flt["hw"]) == 8
        assert json.loads((env.data / "connection.json").read_text())["channels"][0]["alias"] == "Кузов"


def test_connect_failure_reports_status(tmp_path):
    env = Env(tmp_path, fail_connect=True)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        r = call(ws, type="connect", config=CONNECT)
        assert r["ok"] is False
        st = recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "error")
        assert "fake bridge" in st["message"]


def test_rx_loop_failure_reports_status(tmp_path):
    env = Env(tmp_path, raise_on_frames=OSError("bridge gone"))
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        st = recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "error")
        assert "bridge gone" in st["message"]


def test_reconnect_receives_hello_with_live_state(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            connect(ws)
            assert call(ws, type="capture_record", on=True)["ok"]
            assert call(ws, type="tx_upsert", task={"id": "t1", "can_id": 0x7E0, "data": "023e00",
                                                    "period_ms": 20})["ok"]
            assert call(ws, type="tx_start", id="t1")["ok"]
        time.sleep(0.15)
        with client.websocket_connect("/ws") as ws2:
            hello = ws2.receive_json()
            assert hello["status"]["state"] == "opened"
            assert hello["capture"]["recording"] is True and hello["capture"]["count"] > 0
            assert hello["tx"]["tasks"][0]["running"] is True and hello["tx"]["tasks"][0]["count"] > 0
            assert call(ws2, type="tx_pause_all")["ok"]


def test_soft_filter_drops_before_monitor_and_capture(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        assert call(ws, type="range_upsert", filter={"channel": 1, "start": 0x100, "end": 0x1FF})["ok"]
        assert call(ws, type="capture_record", on=True)["ok"]
        s = env.sessions[-1]
        for can_id in (0x100, 0x300, 0x1FF):
            s.push(CanFrame(1, can_id, b"\x01", timestamp=1.0))
        tail = recv_until(ws, lambda m: m["type"] == "capture_tail" and m["count"] >= 2)
        assert [r["id"] for r in tail["rows"]] == [0x100, 0x1FF]
        rows = call(ws, type="capture_rows", start=0, count=10)["data"]["rows"]
        assert [r["id"] for r in rows] == [0x100, 0x1FF]


def test_tx_frames_enter_capture_as_tx(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        call(ws, type="capture_record", on=True)
        assert call(ws, type="tx_upsert", task={"id": "t", "can_id": 0x7E0, "data": "023e00"})["ok"]
        assert call(ws, type="tx_send", id="t")["ok"]
        rows = call(ws, type="capture_rows", start=0, count=10)["data"]["rows"]
        assert rows[-1]["dir"] == "tx" and rows[-1]["id"] == 0x7E0
        assert env.sessions[-1].sent[-1].can_id == 0x7E0


def test_capture_save_and_load_trc(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        call(ws, type="capture_record", on=True)
        call(ws, type="comment_set", id=0x123, ext=False, text="кнопка")
        s = env.sessions[-1]
        for i in range(3):
            s.push(CanFrame(1, 0x123, bytes([i]), timestamp=1.0 + i))
        recv_until(ws, lambda m: m["type"] == "capture_tail" and m["count"] == 3)
        assert call(ws, type="capture_marker", label="", comment="", auto=True)["ok"]
        saved = call(ws, type="capture_save", name="drive", format="trc")
        assert saved["ok"] and saved["data"]["name"] == "drive.trc"
        text = (env.traces / "drive.trc").read_text(encoding="utf-8")
        assert text.startswith("@ TEXT @ 3") and "кнопка" in text
        call(ws, type="capture_clear")
        assert call(ws, type="capture_load", name="drive.trc")["ok"]
        st = recv_until(ws, lambda m: m["type"] == "capture_state" and m["count"] == 3)
        assert st["markers"][0]["label"] == "#1"


def test_capture_to_tracer_and_play_to_monitor(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        call(ws, type="capture_record", on=True)
        s = env.sessions[-1]
        s.push(CanFrame(1, 0x321, b"\x05", timestamp=1.0))
        recv_until(ws, lambda m: m["type"] == "capture_tail" and m["count"] == 1)
        call(ws, type="monitor_clear")
        assert call(ws, type="capture_to_tracer")["ok"]
        assert call(ws, type="tracer_config", patch={"dest": "monitor"})["ok"]
        assert call(ws, type="tracer_play", selection=None)["ok"]
        d = recv_until(ws, lambda m: m["type"] == "monitor_delta" and any(r["id"] == 0x321 for r in m["rows"]))
        assert d


def test_filters_add_id_uses_first_free_slot_and_applies(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        connect(ws)
        r = call(ws, type="filters_add_id", channel=1, id=0x7E8, ext=False)
        assert r["ok"]
        assert env.sessions[-1].filters == [(1, 0, 0x7E8, 0x7FF, False)]
        assert call(ws, type="hw_set", slot={"channel": 1, "index": 0, "enabled": False, "can_id": 0x7E8,
                                             "mask": 0x7FF, "ext": False})["ok"]
        assert env.sessions[-1].cleared == [(1, 0)]


def test_settings_persist_to_store(tmp_path):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        call(ws, type="settings_set", patch={"aggregator": True})
    env2 = Env(tmp_path)
    with TestClient(env2.app) as client, client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["settings"]["aggregator"] is True


@pytest.mark.parametrize("name", ["../x.trc", "a/b.trc", ".hidden.trc", "x.exe"])
def test_capture_save_rejects_bad_names(tmp_path, name):
    env = Env(tmp_path)
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="capture_save", name=name, format="trc")["ok"] is False


def test_desktop_cmt_and_tsk_files_load_and_save(tmp_path):
    env = Env(tmp_path)
    lists = env.data / "lists"
    lists.mkdir(parents=True)
    (lists / "car.cmt").write_bytes("0000012F=Замок колонки\r00000186=Обороты\r".encode("utf-8"))
    (lists / "car.tsk").write_bytes("\r".join([
        "Task.Begin", "Task.Message.Proto=CAN", "Task.Message.Channel=1", "Task.Message.ExtMsgID=false",
        "Task.Message.RTR=false", "Task.Message.MsgID=1EC", "Task.Message.DLC=2", "Task.Message.Data=0102",
        "Task.Delay=50", "Task.Comment=тест", "Task.Trigger.Trigger=None", "Task.Trigger.Delay=0", "Task.End", "",
    ]).encode("utf-8"))
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="comments_load", name="car.cmt", append=False)["ok"]
        c = recv_until(ws, lambda m: m["type"] == "comments")
        assert c["comments"][f"{0x12F}:0"] == "Замок колонки"
        assert call(ws, type="tx_load", name="car.tsk")["ok"]
        st = recv_until(ws, lambda m: m["type"] == "tx_state" and m["tasks"])
        assert st["tasks"][0]["can_id"] == 0x1EC and st["tasks"][0]["period_ms"] == 50
        files = call(ws, type="files_list", kind="lists")["data"]["files"]
        assert {f["name"] for f in files} == {"car.cmt", "car.tsk"}
        assert call(ws, type="comments_save", name="out", format="cmt")["data"]["name"] == "out.cmt"
        assert call(ws, type="tx_save", name="out", format="tsk")["data"]["name"] == "out.tsk"
    assert (lists / "out.cmt").read_bytes().startswith(b"0000012F=")
    assert (lists / "out.tsk").read_bytes().startswith(b"Task.Begin\r")


def test_terminator_only_where_device_supports_it(tmp_path):
    env = Env(tmp_path)
    ch2 = {**CONNECT["channels"][1], "terminator": True, "auto_open": True}
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="connect", config={**CONNECT, "channels": [CONNECT["channels"][0], ch2]})["ok"]
        st = recv_until(ws, lambda m: m["type"] == "status" and m["state"] == "opened")
        assert env.sessions[-1].terminators == {1: True}
        c2 = st["channels"]["2"]
        assert c2["open"] and c2["terminator"] is False and c2["error"] is None
        toast = recv_until(ws, lambda m: m["type"] == "toast")
        assert "Канал 2" in toast["message"] and "терминатор" in toast["message"]
        bad = call(ws, type="channel_terminator", channel=2, enabled=True)
        assert bad["ok"] is False and "терминатор" in bad["error"]


def test_bitrates_keep_clock_and_reject_bad_timing(tmp_path):
    env = Env(tmp_path)
    item = {"caption": "47,6k", "bitrate": 47619, "sample_pct": 80, "clock_hz": 120_000_000,
            "timing": {"prescaler": 140, "seg1": 14, "seg2": 3, "sjw": 3}}
    with TestClient(env.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert call(ws, type="bitrates_set", bitrates=[item])["ok"]
        ev = recv_until(ws, lambda m: m["type"] == "bitrates")
        assert ev["bitrates"] == [item]
        bad = {**item, "timing": {"prescaler": 0, "seg1": 1, "seg2": 1, "sjw": 1}}
        assert call(ws, type="bitrates_set", bitrates=[bad])["ok"] is False
