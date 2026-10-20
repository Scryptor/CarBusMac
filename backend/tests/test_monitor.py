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


# --- A2: флаги, стабильность байт, агрегатор уникальных данных ---
import pytest  # noqa: E402

from app.schemas import row_to_dict  # noqa: E402


def test_stable_ms_measures_time_before_change():
    m = MonitorState()
    m.update(CanFrame(1, 0x10, b"\x00\x00", timestamp=0.0))
    m.update(CanFrame(1, 0x10, b"\x00\x00", timestamp=5.0))
    m.update(CanFrame(1, 0x10, b"\x01\x00", timestamp=7.0))
    r = m.snapshot_delta()[0]
    assert r.changed_mask == 0b11  # первый снапшот: все байты новые
    m.update(CanFrame(1, 0x10, b"\x02\x00", timestamp=7.5))
    r = m.snapshot_delta()[0]
    assert r.changed_mask == 0b01 and r.stable_ms[0] == pytest.approx(500.0)
    assert r.stable_ms[1] is None


def test_first_change_measures_from_first_appearance():
    m = MonitorState()
    m.update(CanFrame(1, 0x11, b"\x00", timestamp=10.0))
    m.update(CanFrame(1, 0x11, b"\x05", timestamp=22.0))
    r = m.snapshot_delta()[0]
    assert r.stable_ms[0] == pytest.approx(12000.0)


def test_aggregator_counts_unique_payloads_and_caps():
    m = MonitorState(aggregator=True, unique_cap=2)
    for i, d in enumerate([b"\x01", b"\x02", b"\x01", b"\x03"]):
        m.update(CanFrame(1, 0x20, d, timestamp=i * 0.1))
    r = m.snapshot_delta()[0]
    assert r.fc == 2                     # третий уникальный не влез в cap
    u = m.unique_frames(1, 0x20, False)
    assert [x.data for x in u] == [b"\x01", b"\x02"] and u[0].count == 2
    assert u[0].period_ms == pytest.approx(200.0)


def test_aggregator_off_reports_zero_and_can_be_enabled():
    m = MonitorState()
    m.update(CanFrame(1, 0x21, b"\x01"))
    assert m.snapshot_delta()[0].fc == 0 and m.unique_frames(1, 0x21, False) == []
    m.set_aggregator(True)
    m.update(CanFrame(1, 0x21, b"\x02"))
    assert m.snapshot_delta()[0].fc == 1


def test_snapshot_all_returns_every_row_without_consuming_delta():
    m = MonitorState()
    m.update(CanFrame(1, 1, b"\x00", timestamp=0))
    assert len(m.snapshot_all()) == 1 and len(m.snapshot_delta()) == 1


def test_row_flags_and_dict_keys():
    m = MonitorState()
    m.update(CanFrame(2, 0x7E0, b"", rtr=True, timestamp=1.0))
    d = row_to_dict(m.snapshot_delta()[0])
    assert d["rtr"] is True and d["fd"] is False and d["ch"] == 2
    assert set(d) == {"ch", "id", "ext", "rtr", "fd", "brs", "dlc", "data", "count",
                      "period_ms", "changed", "stable_ms", "fc", "ts"}
