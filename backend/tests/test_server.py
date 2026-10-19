from fastapi.testclient import TestClient

from app.models import CanFrame
from app.can_session import FakeSession
from app.server import create_app


def _wait(ws, type_, tries=100):
    for _ in range(tries):
        msg = ws.receive_json()
        if msg.get("type") == type_:
            return msg
    raise AssertionError(f"no {type_} message")


def test_connect_then_device_info():
    app = create_app(lambda: FakeSession(info={"hardware_name": "HW_CH32"}))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        assert _wait(ws, "device_info")["info"]["hardware_name"] == "HW_CH32"


def test_bad_input_keeps_socket_alive():          # Review Focus: невалидный ввод
    app = create_app(lambda: FakeSession(info={"hardware_name": "X"}))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_text("{not json")
        assert _wait(ws, "error")
        ws.send_json({"type": "nonsense"})
        assert _wait(ws, "error")
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        assert _wait(ws, "device_info")           # сокет жив


def test_session_connect_failure_reports_status():  # Review Focus: мост недоступен
    app = create_app(lambda: FakeSession(fail_connect=True))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        st = _wait(ws, "status")
        assert st["connected"] is False and st["message"]


def test_tx_shot_reaches_session():
    captured = FakeSession(info={"hardware_name": "X"})
    with TestClient(create_app(lambda: captured)).websocket_connect("/ws") as ws:
        ws.send_json({"type": "connect", "bridge_host": "h", "bridge_port": 7000})
        _wait(ws, "device_info")
        ws.send_json({
            "type": "tx_shot",
            "frame": {"channel": 1, "can_id": 2016, "data": "023e00", "extended": False},
        })
        _wait(ws, "status")
        assert captured.sent and captured.sent[-1].can_id == 2016
