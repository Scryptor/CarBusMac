"""Фоновое логирование потока: .trc пишется по ходу приёма, заголовок с числом кадров и
длительностью — при остановке; метаинформация и TX — по настройкам."""
from datetime import datetime

from app.logger import StreamLogger, trc_meta
from app.models import CanFrame
from app.tracefmt import read_trace

SETTINGS = {"log_name_mask": "%Y-%m-%d_%H-%M-%S", "log_record_tx": True}
CLOCK = datetime(2026, 10, 20, 17, 30, 5, 123000)


def test_logger_writes_trc_with_meta_and_tx_when_enabled(tmp_path):
    lg = StreamLogger(tmp_path, SETTINGS, now=lambda: CLOCK)
    path = lg.start({"TransportBrand": "Lada", "TransportModel": "Vesta"})
    assert path == tmp_path / "2026-10-20_17-30-05.trc" and lg.active
    lg.write(CanFrame(1, 0x120, b"\x01\x02", timestamp=10.0))
    lg.write(CanFrame(1, 0x7E0, b"\x02\x10\x03", timestamp=10.25, direction="tx"))
    out = lg.stop()
    lines = out.read_bytes().decode("utf-8").split("\r\n")
    assert lines[0] == "@ TEXT @ 3 @ 64 @ 0 @ 2 @ 250 @ 00:00:00.250 @"
    assert lines[1] == "# $LocalTime=17:30:05.123"
    assert "# TransportBrand=Lada" in lines and "# TransportModel=Vesta" in lines
    assert [f.can_id for f in read_trace(out).frames] == [0x120, 0x7E0]
    assert [p.name for p in tmp_path.iterdir()] == ["2026-10-20_17-30-05.trc"]
    assert not lg.active


def test_logger_skips_tx_when_disabled_and_drops_empty_logs(tmp_path):
    lg = StreamLogger(tmp_path, {**SETTINGS, "log_record_tx": False}, now=lambda: CLOCK)
    lg.start({})
    lg.write(CanFrame(1, 0x7E0, b"\x02", timestamp=1.0, direction="tx"))
    assert lg.stop() is None and list(tmp_path.iterdir()) == []


def test_logger_name_is_safe_and_unique(tmp_path):
    (tmp_path / "car_2026.trc").write_text("x")
    lg = StreamLogger(tmp_path, {**SETTINGS, "log_name_mask": "../car/%Y"}, now=lambda: CLOCK)
    assert lg.start({}).name == "car_2026_2.trc"
    lg.stop()


def test_trc_meta_maps_settings_keys():
    meta = trc_meta({"transport": "Легковой", "brand": "Lada", "model": "", "body": "Седан", "year": "2024"})
    assert meta == {"TransportType": "Легковой", "TransportBrand": "Lada", "TransportBody": "Седан", "TransportYear": "2024"}
