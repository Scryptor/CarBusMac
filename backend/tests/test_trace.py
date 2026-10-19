from app.models import CanFrame
from app.trace import TraceWriter, TraceReader, TracePlayer


def _done():
    async def _n():
        return None
    return _n()


def test_trace_roundtrip_preserves_ts_source(tmp_path):
    p = str(tmp_path / "t.jsonl")
    w = TraceWriter(p)
    w.write(CanFrame(1, 0x1A, b"\xde\xad", timestamp=5.0, ts_source="device"))
    w.write(CanFrame(2, 0x2B, b"\xff", timestamp=5.25, ts_source="arrival"), direction="tx")
    w.close()
    fr = TraceReader(p).frames()
    assert [f.can_id for f in fr] == [0x1A, 0x2B]
    assert fr[0].data == b"\xde\xad" and fr[0].ts_source == "device"
    assert fr[1].channel == 2


async def test_player_respects_interframe_delay():
    slept = []

    async def fake_sleep(d):
        slept.append(d)

    sent = []
    frames = [CanFrame(1, 1, b"", timestamp=0.0), CanFrame(1, 2, b"", timestamp=0.2)]
    await TracePlayer(frames).play(
        send=lambda f: sent.append(f) or _done(), speed=2.0, sleep=fake_sleep
    )
    assert [f.can_id for f in sent] == [1, 2]
    assert abs(slept[0] - 0.1) < 1e-6   # 0.2s / speed 2.0


def test_player_step_advances_then_exhausts():
    p = TracePlayer([CanFrame(1, 1, b""), CanFrame(1, 2, b"")])
    assert p.step().can_id == 1
    assert p.step().can_id == 2
    assert p.step() is None
