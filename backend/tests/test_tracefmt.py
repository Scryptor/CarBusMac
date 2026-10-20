from pathlib import Path

import pytest

from app.capture import Marker
from app.models import CanFrame
from app.tracefmt import TraceDoc, format_jsonl, format_trc, parse_jsonl, parse_trc, read_trace, write_trace

FIXTURE = Path(__file__).parent / "fixtures" / "desktop_v3.trc"


def test_read_trc_wraps_minutes_and_skips_lin():
    d = parse_trc(FIXTURE.read_text())
    assert [f.can_id for f in d.frames] == [0x1AA, 0x18DAF110, 0x1AB, 0x7E0]
    assert [round(f.timestamp, 3) for f in d.frames] == [59.5, 59.9, 60.1, 61.0]
    assert d.frames[1].extended and d.frames[3].rtr and d.skipped == 1
    assert d.frames[1].channel == 2 and d.frames[1].data == b"\x02\x7e\x00"
    assert d.markers == [Marker(1, "M1", "marker note")] and d.comments[0] == "first"
    assert d.meta["$LocalTime"] == "10:20:30.000"


def test_trc_roundtrip_is_stable():
    d = parse_trc(FIXTURE.read_text())
    again = parse_trc(format_trc(d))
    assert [(f.channel, f.can_id, f.data, f.extended, f.rtr) for f in again.frames] == \
           [(f.channel, f.can_id, f.data, f.extended, f.rtr) for f in d.frames]
    assert [round(f.timestamp - again.frames[0].timestamp, 6) for f in again.frames] == \
           [round(f.timestamp - d.frames[0].timestamp, 6) for f in d.frames]
    assert again.markers == d.markers and again.comments == d.comments


def test_trc_header_line_matches_desktop_layout():
    text = format_trc(parse_trc(FIXTURE.read_text()))
    line = text.split("\r\n")[0]
    parts = [p.strip() for p in line.split("@")]
    assert len(parts) == 9 and parts[1:4] == ["TEXT", "3", "64"] and parts[5] == "4"
    assert parts[6] == "1500" and parts[7] == "00:00:01.500"


def test_trc_frame_line_layout():
    doc = TraceDoc(frames=[CanFrame(1, 0x18DAF110, b"\x02\x7e\x00", extended=True, timestamp=5.0)],
                   markers=[], comments={0: "ответ"}, meta={})
    line = format_trc(doc).split("\r\n")[1]
    f = line.split("\t")
    assert f[0] == "00,000000" and f[1] == "1" and f[2] == "00000005" and f[3] == "18DAF110"
    assert f[4] == "3" and f[5].rstrip() == "02 7E 00" and f[6] == "00000000"
    assert f[7] == " ~      " and f[8] == "ответ"   # как в реальных файлах десктопа: пробелы, ширина 8


def test_trc_unsupported_version_is_explicit():
    with pytest.raises(ValueError, match="версия"):
        parse_trc("@ TEXT @ 2 @ 64 @ 0 @ 0 @ 0 @ 00:00:00.000 @\r\n")


def test_trc_not_a_trace_is_explicit():
    with pytest.raises(ValueError, match="формат"):
        parse_trc("hello\r\n")


def test_trc_bad_line_reports_line_number():
    text = "@ TEXT @ 3 @ 64 @ 0 @ 1 @ 0 @ 00:00:00.000 @\r\nxx\tyy\tzz\tqq\tww\tee\trr\ttt\tuu\r\n"
    with pytest.raises(ValueError, match="строке 2"):
        parse_trc(text)


def test_jsonl_roundtrip_keeps_direction_and_markers():
    doc = TraceDoc(
        frames=[CanFrame(1, 0x7E0, b"\x02\x3e\x00", timestamp=1.0, direction="tx"),
                CanFrame(1, 0x7E8, b"\x02\x7e\x00", timestamp=1.01, ts_source="arrival")],
        markers=[Marker(1, "ответ", "")], comments={1: "tester present"}, meta={"brand": "Lada"})
    back = parse_jsonl(format_jsonl(doc))
    assert [f.direction for f in back.frames] == ["tx", "rx"]
    assert back.frames[1].ts_source == "arrival" and back.markers == doc.markers
    assert back.comments == {1: "tester present"} and back.meta["brand"] == "Lada"


def test_jsonl_reads_legacy_v1_lines_without_header():
    legacy = '{"ts": 1.5, "ts_source": "device", "ch": 2, "id": 291, "ext": false, "dlc": 1, "data": "ff", "dir": "rx"}\n'
    d = parse_jsonl(legacy)
    assert d.frames[0].channel == 2 and d.frames[0].can_id == 0x123 and d.frames[0].data == b"\xff"


def test_read_write_trace_by_extension(tmp_path):
    doc = parse_trc(FIXTURE.read_text())
    for name in ("a.trc", "a.jsonl"):
        write_trace(tmp_path / name, doc)
        assert [f.can_id for f in read_trace(tmp_path / name).frames] == [f.can_id for f in doc.frames]
    with pytest.raises(ValueError):
        read_trace(tmp_path / "a.csv")


def test_read_trace_accepts_cp1251_comments(tmp_path):
    text = FIXTURE.read_text().replace("first", "первый")
    (tmp_path / "w.trc").write_bytes(text.encode("cp1251"))
    assert read_trace(tmp_path / "w.trc").comments[0] == "первый"
