import app.server as srv
from fastapi.testclient import TestClient

from app.models import CanFrame
from app.can_session import FakeSession
from app.server import create_app
from app.trace import TraceWriter


def _wait(ws, type_, tries=100):
    for _ in range(tries):
        msg = ws.receive_json()
        if msg.get("type") == type_:
            return msg
    raise AssertionError(f"no {type_} message")


def _wait_pred(ws, pred, tries=100):
    for _ in range(tries):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("predicate never satisfied")


def test_connect_then_device_info():
    app = create_app(lambda *a: FakeSession(info={"hardware_name": "HW_CH32"}))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        assert _wait(ws, "device_info")["info"]["hardware_name"] == "HW_CH32"


def test_connect_uses_bridge_host_port():        # Important #3: UI target must reach factory
    seen: dict = {}

    def factory(host, port):
        seen["host"], seen["port"] = host, port
        return FakeSession(info={"hardware_name": "X"})

    with TestClient(create_app(factory)).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "1.2.3.4", "bridge_port": 9999})
        _wait(ws, "device_info")
        assert seen == {"host": "1.2.3.4", "port": 9999}


def test_bad_input_keeps_socket_alive():          # Review Focus: невалидный ввод
    app = create_app(lambda *a: FakeSession(info={"hardware_name": "X"}))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_text("{not json")
        assert _wait(ws, "error")
        ws.send_json({"type": "nonsense"})
        assert _wait(ws, "error")
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        assert _wait(ws, "device_info")


def test_bad_hex_tx_shot_errors_and_survives():   # Review Focus #5: битый hex
    captured = FakeSession(info={"hardware_name": "X"})
    with TestClient(create_app(lambda *a: captured)).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        ws.send_json({"type": "tx_shot", "frame": {"channel": 1, "can_id": 1, "data": "zz"}})
        assert _wait(ws, "error")
        ws.send_json({"type": "tx_shot", "frame": {"channel": 1, "can_id": 2, "data": "01"}})
        _wait(ws, "status")
        assert captured.sent and captured.sent[-1].can_id == 2


def test_session_connect_failure_reports_status():  # Review Focus: мост недоступен (connect)
    app = create_app(lambda *a: FakeSession(fail_connect=True))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        st = _wait(ws, "status")
        assert st["connected"] is False and st["message"]


def test_rx_loop_failure_reports_status():        # Important #1: обрыв моста в середине сессии
    app = create_app(
        lambda *a: FakeSession(info={"hardware_name": "X"}, raise_on_frames=ConnectionError("bridge dropped"))
    )
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        st = _wait_pred(ws, lambda m: m.get("type") == "status" and m.get("connected") is False)
        assert st["message"]


def test_tx_shot_reaches_session():
    captured = FakeSession(info={"hardware_name": "X"})
    with TestClient(create_app(lambda *a: captured)).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        ws.send_json({
            "type": "tx_shot",
            "frame": {"channel": 1, "can_id": 2016, "data": "023e00", "extended": False},
        })
        _wait(ws, "status")
        assert captured.sent and captured.sent[-1].can_id == 2016


def test_tracer_step_advances_into_monitor(tmp_path, monkeypatch):  # Important #4: Step не пустышка
    monkeypatch.setattr(srv, "TRACES_DIR", tmp_path)
    w = TraceWriter(str(tmp_path / "t.jsonl"))
    w.write(CanFrame(1, 0x55, b"\x01"))
    w.close()
    with TestClient(create_app(lambda *a: FakeSession(info={"hardware_name": "X"}))).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        ws.send_json({"type": "tracer_load", "name": "t.jsonl"})
        _wait(ws, "status")
        ws.send_json({"type": "tracer_step"})
        d = _wait(ws, "monitor_delta")
        assert d["rows"][0]["id"] == 0x55


def test_record_start_sanitizes_path(tmp_path, monkeypatch):  # Important(re-graded): обход каталога
    monkeypatch.setattr(srv, "TRACES_DIR", tmp_path)
    with TestClient(create_app(lambda *a: FakeSession(info={"hardware_name": "X"}))).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        ws.send_json({"type": "record_start", "name": "../../evil"})
        _wait(ws, "status")
        assert (tmp_path / "evil.jsonl").exists()
        assert not (tmp_path.parent.parent / "evil.jsonl").exists()
