from app.models import CanFrame
from app.store import JsonStore


def test_store_roundtrip_and_default(tmp_path):
    s = JsonStore(tmp_path)
    assert s.load("x", {"a": 1}) == {"a": 1}
    s.save("x", {"a": 2})
    assert JsonStore(tmp_path).load("x", None) == {"a": 2}
    assert not list(tmp_path.glob("*.tmp"))


def test_store_corrupt_file_falls_back_to_default(tmp_path):
    (tmp_path / "x.json").write_text("{broken")
    assert JsonStore(tmp_path).load("x", 7) == 7


def test_store_creates_missing_root(tmp_path):
    root = tmp_path / "nested" / "data"
    JsonStore(root).save("y", [1, 2])
    assert JsonStore(root).load("y", []) == [1, 2]


def test_frame_direction_defaults_to_rx():
    assert CanFrame(1, 0x100).direction == "rx"
