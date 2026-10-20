import asyncio

import pytest

from app.capture import Marker
from app.models import CanFrame
from app.tracefmt import TraceDoc
from app.tracer import PlayerConfig, TracePlayer, TracerDoc, TraceRow


class FakeSleep:
    def __init__(self):
        self.calls = []

    async def __call__(self, d):
        self.calls.append(round(d, 6))
        await asyncio.sleep(0)


async def _drain(n=40):
    for _ in range(n):
        await asyncio.sleep(0)


def _doc(*specs):
    """specs: (ts, can_id[, channel])"""
    frames = [CanFrame(s[2] if len(s) > 2 else 1, s[1], b"\x01", timestamp=s[0]) for s in specs]
    d = TracerDoc()
    d.load(TraceDoc(frames=frames), "t.trc")
    return d


def _player(doc, **cfg):
    sent, sleep = [], FakeSleep()

    async def send(frame, target):
        sent.append((frame, target))

    p = TracePlayer(doc, send=send, sleep=sleep)
    p.config = PlayerConfig(**cfg)
    return p, sent, sleep


async def test_play_respects_timestamp_delays_and_max_1s():
    p, sent, sleep = _player(_doc((0.0, 1), (0.5, 2), (3.0, 3)))
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [1, 2, 3] and sleep.calls == [0.5, 2.5]
    assert p.state == "stopped"
    p2, _, sleep2 = _player(_doc((0.0, 1), (0.5, 2), (3.0, 3)), max_1s=True)
    await p2.play()
    await _drain()
    assert sleep2.calls == [0.5, 1.0]


async def test_fixed_delay_mode():
    p, sent, sleep = _player(_doc((0.0, 1), (5.0, 2), (9.0, 3)), delay_mode="fixed", fixed_ms=20)
    await p.play()
    await _drain()
    assert sleep.calls == [0.02, 0.02] and len(sent) == 3


async def test_disabled_rows_and_ids_are_skipped():
    doc = _doc((0, 1), (0, 2), (0, 3), (0, 2))
    doc.set_enabled([0], False)
    doc.set_ids_enabled([(1, 2, False)], False)
    p, sent, _ = _player(doc)
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [3]


async def test_only_channel_filters_rows():
    p, sent, _ = _player(_doc((0, 1, 1), (0, 2, 2), (0, 3, 1)), only_channel=1)
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [1, 3]


async def test_pauses_before_breakpoint_and_resumes():
    doc = _doc((0, 1), (0, 2), (0, 3))
    doc.set_bp(1, True)
    p, sent, _ = _player(doc)
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [1] and p.state == "paused" and p.current == 1
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [1, 2, 3] and p.state == "stopped"


async def test_breakpoint_ignored_when_option_off():
    doc = _doc((0, 1), (0, 2))
    doc.set_bp(1, True)
    p, sent, _ = _player(doc, stop_on_bp=False)
    await p.play()
    await _drain()
    assert len(sent) == 2


async def test_stop_on_rx_pauses():
    doc = _doc((0, 1), (1, 2), (2, 3))
    p, sent, _ = _player(doc, stop_on_rx=True)

    async def send(frame, target):
        sent.append((frame, target))
        p.notify_rx()                          # шина ответила сразу после первого кадра

    p._send = send
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [1] and p.state == "paused"


async def test_selection_plays_only_selected():
    p, sent, _ = _player(_doc((0, 1), (0, 2), (0, 3), (0, 4)))
    await p.play(selection=[3, 1])
    await _drain()
    assert [f.can_id for f, _ in sent] == [2, 4]


async def test_step_advances_one_playable_row():
    doc = _doc((0, 1), (0, 2), (0, 3))
    doc.set_enabled([1], False)
    p, sent, _ = _player(doc)
    await p.step()
    assert [f.can_id for f, _ in sent] == [1] and p.state == "paused" and p.current == 0
    await p.step()
    assert [f.can_id for f, _ in sent] == [1, 3] and p.current == 2
    await p.play()
    await _drain()
    assert p.state == "stopped" and len(sent) == 2


async def test_dest_channel_rewrites_frame_channel():
    p, sent, _ = _player(_doc((0, 1, 1)), dest="ch2")
    await p.play()
    await _drain()
    f, target = sent[0]
    assert f.channel == 2 and target == "bus" and f.direction == "tx"
    p2, sent2, _ = _player(_doc((0, 1, 1)), dest="monitor")
    await p2.play()
    await _drain()
    f, target = sent2[0]
    assert f.channel == 1 and target == "monitor"


async def test_loop_repeats_until_stopped():
    p, sent, _ = _player(_doc((0, 1), (0, 2)), loop=True)
    await p.play()
    await _drain()
    assert len(sent) > 4 and p.state == "playing"
    p.stop()
    n = len(sent)
    await _drain()
    assert len(sent) == n and p.state == "stopped"


async def test_before_and_after_delays_are_added():
    doc = _doc((0, 1), (0.1, 2))
    doc.rows[1].before_ms = 50
    doc.rows[1].after_ms = 30
    p, _, sleep = _player(doc)
    await p.play()
    await _drain()
    assert sleep.calls == [0.15, 0.03]


def test_edit_ops_mark_modified_and_shift_markers():
    doc = _doc((0, 1), (1, 2), (2, 3))
    doc.markers = [Marker(2, "M", "")]
    assert not doc.modified
    doc.add(TraceRow(CanFrame(1, 9, b"", timestamp=0.5)), index=1)
    assert [r.frame.can_id for r in doc.rows] == [1, 9, 2, 3] and doc.markers[0].index == 3
    doc.edit(0, TraceRow(CanFrame(1, 7, b"\x07", timestamp=0)))
    doc.delete([1, 2])
    assert [r.frame.can_id for r in doc.rows] == [7, 3] and doc.markers[0].index == 1
    doc.add(TraceRow(CanFrame(2, 5, b"", timestamp=3)), index=None)
    assert doc.rows[-1].frame.can_id == 5 and doc.modified and doc.channels() == [1, 2]


def test_ids_table_counts_and_rows_view():
    doc = _doc((10.0, 0x100), (10.5, 0x200), (11.0, 0x100))
    doc.rows[2].comment = "c"
    ids = doc.ids()
    assert ids == [{"ch": 1, "id": 0x100, "ext": False, "count": 2, "enabled": True},
                   {"ch": 1, "id": 0x200, "ext": False, "count": 1, "enabled": True}]
    v = doc.rows_view(1, 5)
    assert [r["i"] for r in v] == [1, 2] and v[0]["t"] == 0.5 and v[1]["comment"] == "c"
    assert set(v[0]) == {"i", "pos", "t", "ch", "dir", "id", "ext", "rtr", "dlc", "data", "enabled", "bp",
                         "start", "finish", "before_ms", "after_ms", "comment", "marker"}


def test_unchecked_ids_are_hidden_from_rows_view():
    doc = _doc((0, 1), (1, 2), (2, 1), (3, 3))
    doc.set_ids_enabled([(1, 2, False)], False)
    assert doc.visible_count() == 3
    v = doc.rows_view(0, 10)
    assert [(r["pos"], r["i"]) for r in v] == [(0, 0), (1, 2), (2, 3)]
    assert doc.rows_view(1, 1)[0]["i"] == 2


def test_positions_map_to_indices_and_back():
    doc = _doc((0, 1), (1, 2), (2, 1), (3, 3))
    doc.set_ids_enabled([(1, 2, False)], False)
    assert doc.indices([0, 1, 2, 9]) == [0, 2, 3]
    assert [doc.position(i) for i in range(4)] == [0, None, 1, 2]
    assert doc.find((1, 1, False)) == [0, 1]
    doc.set_ids_enabled([(1, 2, False)], True)
    assert doc.find((1, 2, False)) == [1] and doc.visible_count() == 4


def test_visible_rows_follow_edits():
    doc = _doc((0, 1), (1, 2), (2, 1))
    doc.set_ids_enabled([(1, 2, False)], False)
    doc.add(TraceRow(CanFrame(1, 2, b"", timestamp=0.5)), index=1)
    doc.add(TraceRow(CanFrame(1, 5, b"", timestamp=0.7)), index=2)
    assert [r["id"] for r in doc.rows_view(0, 10)] == [1, 5, 1]
    doc.delete([0])
    assert [r["i"] for r in doc.rows_view(0, 10)] == [1, 3]


def test_to_trace_doc_keeps_comments_and_markers():
    doc = _doc((0, 1), (1, 2))
    doc.rows[1].comment = "x"
    doc.markers = [Marker(1, "M", "")]
    td = doc.to_trace_doc()
    assert td.comments == {1: "x"} and td.markers == [Marker(1, "M", "")] and len(td.frames) == 2


def test_set_enabled_by_id_touches_all_rows_with_that_id():
    doc = _doc((0, 1), (0, 2), (0, 1))
    doc.set_enabled_by_id((1, 1, False), False)
    assert [r.enabled for r in doc.rows] == [False, True, False]


@pytest.mark.parametrize("bad", [{"delay_mode": "warp"}, {"dest": "ch9"}, {"fixed_ms": 5}])
def test_player_config_validates(bad):
    with pytest.raises(ValueError):
        PlayerConfig.from_patch(PlayerConfig(), bad)


async def test_start_and_finish_bound_playback():
    doc = _doc((0, 1), (0.01, 2), (0.02, 3), (0.03, 4), (0.04, 5))
    doc.set_bound("start", 1)
    doc.set_bound("finish", 3)
    p, sent, _ = _player(doc)
    await p.play()
    await _drain()
    assert [f.can_id for f, _ in sent] == [2, 3, 4]
    v = doc.rows_view(0, 5)
    assert [r["start"] for r in v] == [False, True, False, False, False]
    assert [r["finish"] for r in v] == [False, False, False, True, False]
    doc.set_bound("start", 1)                      # повторно на той же строке — снять
    assert not any(r.start for r in doc.rows)
    doc.set_bound("finish", None)
    assert not any(r.finish for r in doc.rows)
