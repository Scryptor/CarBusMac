from app.models import CanFrame
from app.monitor import MonitorState


def test_period_and_last_value_wins():
    m = MonitorState()
    m.update(CanFrame(1, 0x100, b"\x00", timestamp=1.0))
    m.update(CanFrame(1, 0x100, b"\x01", timestamp=1.1))
    rows = {(r.channel, r.can_id): r for r in m.snapshot_delta()}
    r = rows[(1, 0x100)]
    assert r.count == 2 and r.data == b"\x01"
    assert abs(r.period_ms - 100.0) < 1e-6


def test_changed_mask_tracks_bytes_since_last_snapshot():
    m = MonitorState()
    m.update(CanFrame(1, 0x200, b"\xAA\xBB"))
    m.snapshot_delta()                       # сбрасывает «изменения»
    m.update(CanFrame(1, 0x200, b"\xAA\xCC"))
    r = m.snapshot_delta()[0]
    assert r.changed_mask == 0b10            # изменился только байт 1


def test_snapshot_delta_returns_only_changed():
    m = MonitorState()
    m.update(CanFrame(1, 0x300, b"\x01"))
    assert len(m.snapshot_delta()) == 1
    assert m.snapshot_delta() == []          # без новых апдейтов — пусто


def test_coalesces_many_updates_to_last_value():  # Review Focus: высокая загрузка
    m = MonitorState()
    for i in range(1000):
        m.update(CanFrame(1, 0x400, bytes([i & 0xFF]), timestamp=i * 0.001))
    rows = m.snapshot_delta()
    assert len(rows) == 1
    assert rows[0].data == bytes([999 & 0xFF])
    assert rows[0].count == 1000


def test_distinct_keys_for_std_and_ext_same_id():
    m = MonitorState()
    m.update(CanFrame(1, 0x1, b"\x00", extended=False))
    m.update(CanFrame(1, 0x1, b"\x00", extended=True))
    assert len(m.snapshot_delta()) == 2
