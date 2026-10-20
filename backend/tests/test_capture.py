import time

from app.capture import Capture, Marker
from app.models import CanFrame


def test_capture_appends_only_while_recording():
    c = Capture()
    assert not c.append(CanFrame(1, 1, b"\x01", timestamp=1.0))
    c.start()
    assert c.append(CanFrame(1, 1, b"\x01", timestamp=1.0))
    c.append(CanFrame(2, 0x18DAF110, b"\x02\x7e\x00", extended=True, timestamp=1.5, direction="tx"))
    rows = c.rows(0, 10)
    assert [r["t"] for r in rows] == [0.0, 0.5]
    assert rows[1]["dir"] == "tx" and rows[1]["ext"] and rows[1]["id"] == 0x18DAF110
    assert rows[1]["data"] == "027e00" and rows[1]["dlc"] == 3 and rows[1]["ch"] == 2


def test_pause_keeps_buffer_and_clear_resets():
    c = Capture()
    c.start()
    c.append(CanFrame(1, 1, timestamp=0))
    c.pause()
    assert not c.append(CanFrame(1, 2, timestamp=1)) and len(c) == 1
    c.clear()
    assert len(c) == 0 and c.t0 is None and c.markers == []


def test_marker_attaches_to_next_row():
    c = Capture()
    c.start()
    c.append(CanFrame(1, 1, timestamp=0))
    m = c.add_marker("A", "note")
    c.append(CanFrame(1, 2, timestamp=1))
    assert m == Marker(1, "A", "note")
    assert c.rows(1, 1)[0]["marker"] == {"label": "A", "comment": "note"}
    assert c.rows(0, 1)[0]["marker"] is None


def test_capture_stops_at_limit():
    c = Capture(limit=3)
    c.start()
    for i in range(5):
        c.append(CanFrame(1, i, timestamp=i))
    assert len(c) == 3 and c.full and not c.recording


def test_rtr_and_long_payload_roundtrip_through_frame():
    c = Capture()
    c.start()
    c.append(CanFrame(1, 0x7E0, b"", rtr=True, timestamp=0))
    c.append(CanFrame(1, 0x100, bytes(range(12)), fd=True, timestamp=0.1))
    assert c.frame(0).rtr and c.frame(0).data == b""
    assert c.frame(1).data == bytes(range(12)) and c.frame(1).fd


def test_load_replaces_buffer_and_duration():
    c = Capture()
    frames = [CanFrame(1, 1, timestamp=10.0), CanFrame(1, 2, timestamp=12.5)]
    c.load(frames, [Marker(1, "M", "")])
    assert len(c) == 2 and c.duration_s() == 2.5 and c.markers[0].index == 1
    assert [f.can_id for f in c.frames()] == [1, 2]


def test_rows_out_of_range_are_clipped():
    c = Capture()
    c.start()
    c.append(CanFrame(1, 1, timestamp=0))
    assert c.rows(5, 10) == [] and len(c.rows(0, 100)) == 1


def test_capture_append_200k_is_fast():
    c = Capture()
    c.start()
    t = time.perf_counter()
    for i in range(200_000):
        c.append(CanFrame(1, i & 0x7FF, b"\x01\x02\x03\x04\x05\x06\x07\x08", timestamp=i / 1e4))
    assert time.perf_counter() - t < 2.0 and c.frame(199_999).data[7] == 8
