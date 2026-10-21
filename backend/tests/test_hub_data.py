"""Поток, трейсы и списки на уровне хаба: загрузка во время записи, заполнение буфера,
метки, комментарии, RTR, $LocalTime, неверные и отсутствующие файлы, старт с битыми данными."""
import asyncio
import json
from datetime import datetime, timezone

import pytest

from app.can_session import FakeSession
from app.hub import CommandError, Hub
from app.models import CanFrame
from app.store import JsonStore
from app.tracefmt import TraceDoc, read_trace, write_trace

from tests.test_hub import INFO


class Sink:
    def __init__(self):
        self.msgs = []

    def send(self, m):
        self.msgs.append(m)

    def of(self, t):
        return [m for m in self.msgs if m.get("type") == t]


def _hub(tmp_path, **kw):
    hub = Hub(lambda *a: FakeSession(info=INFO), JsonStore(tmp_path / "data"), tmp_path / "traces",
              tmp_path / "data", **kw)
    sink = Sink()
    hub.clients.add(sink)
    return hub, sink


def _frames(n, can_id=0x100, t0=1.0):
    return [CanFrame(1, can_id + k % 3, bytes([k & 0xFF]), timestamp=t0 + k * 0.01) for k in range(n)]


def test_loading_a_trace_stops_recording(tmp_path):
    hub, _ = _hub(tmp_path)
    write_trace(tmp_path / "traces.trc", TraceDoc(frames=_frames(5)))
    (tmp_path / "traces").mkdir()
    (tmp_path / "traces.trc").rename(tmp_path / "traces" / "a.trc")

    async def run():
        await hub._cmd_capture_record({"on": True})
        await hub._on_rx(CanFrame(1, 0x7FF, b"\x01", timestamp=1.0))
        await hub._cmd_capture_load({"name": "a.trc"})
        await hub._on_rx(CanFrame(1, 0x7FF, b"\x02", timestamp=2.0))   # живой кадр после загрузки
    asyncio.run(run())
    assert len(hub.capture) == 5 and hub.capture.recording is False


def test_full_buffer_is_reported(tmp_path):
    hub, sink = _hub(tmp_path)
    hub.capture.limit = 3
    hub.capture.start()
    hub._capture_state()                   # клиенты знают «идёт запись»

    async def run():
        for f in _frames(3):
            await hub._on_rx(f)
    asyncio.run(run())
    hub._tick()
    st = sink.of("capture_state")[-1]
    assert st["full"] is True and st["recording"] is False


def test_tracer_edits_do_not_move_stream_markers(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()

    async def run():
        for f in _frames(4):
            await hub._on_rx(f)
        await hub._cmd_capture_marker({"label": "газ"})
        await hub._on_rx(CanFrame(1, 0x200, b"\x01", timestamp=9.0))
        await hub._cmd_capture_to_tracer({})
        await hub._cmd_tracer_row_add({"row": {"id": 0x123, "data": "01"}, "after": 0})
    asyncio.run(run())
    assert hub.capture.markers[0].index == 4 and hub.tracer.markers[0].index == 5


def test_marker_numbers_do_not_repeat(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()

    async def run():
        a = await hub._cmd_capture_marker({"label": ""})
        b = await hub._cmd_capture_marker({"auto": True})
        return a["label"], b["label"]
    assert asyncio.run(run()) == ("#1", "#2")


def test_tab_in_comment_does_not_break_saved_trace(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()

    async def run():
        await hub._cmd_comment_set({"id": 0x100, "text": "газ\tпедаль\nвниз"})
        for f in _frames(3):
            await hub._on_rx(f)
        await hub._cmd_capture_save({"name": "c.trc"})
    asyncio.run(run())
    doc = read_trace(tmp_path / "traces" / "c.trc")
    assert len(doc.frames) == 3 and doc.comments[0] == "газ педаль вниз"


def test_id_comment_edits_are_visible_in_tracer_and_saved(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()

    async def run():
        await hub._cmd_comment_set({"id": 0x100, "text": "старый"})
        for f in _frames(3):
            await hub._on_rx(f)
        await hub._cmd_capture_to_tracer({})
        await hub._cmd_comment_set({"id": 0x100, "text": "новый"})      # F4 в отладчике
        await hub._cmd_tracer_save({"name": "t.trc"})
    asyncio.run(run())
    assert hub.tracer.rows_view(0, 1)[0]["comment"] == ""                # строка своего не держит
    assert read_trace(tmp_path / "traces" / "t.trc").comments[0] == "новый"


def test_only_channel_resets_when_trace_lacks_it(tmp_path):
    hub, _ = _hub(tmp_path)
    (tmp_path / "traces").mkdir()
    write_trace(tmp_path / "traces" / "one.jsonl", TraceDoc(frames=_frames(3)))

    async def run():
        await hub._cmd_tracer_config({"patch": {"only_channel": 2}})
        await hub._cmd_tracer_open({"name": "one.jsonl"})
    asyncio.run(run())
    assert hub.player.config.only_channel is None


def test_deleting_rows_stops_the_player(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.player.config.dest = "monitor"
    hub.tracer.load(TraceDoc(frames=_frames(50)), None)

    async def run():
        await hub._cmd_tracer_play({})
        await asyncio.sleep(0)
        await hub._cmd_tracer_rows_delete({"positions": list(range(10))})
    asyncio.run(run())
    assert hub.player.state == "stopped" and len(hub.tracer.rows) == 40


def test_wrong_kind_of_list_file_keeps_current_lists(tmp_path):
    hub, _ = _hub(tmp_path)
    lists = tmp_path / "data" / "lists"
    lists.mkdir(parents=True)
    (lists / "filters.json").write_text(json.dumps({"kind": "filters", "hw": [], "ranges": []}))
    (lists / "tx.json").write_text(json.dumps({"kind": "transmit", "transmit": []}))

    async def run():
        await hub._cmd_tx_upsert({"task": {"id": "t", "can_id": 0x100}})
        await hub._cmd_comment_set({"id": 0x100, "text": "x"})
        with pytest.raises(CommandError, match="нет списка передачи"):
            await hub._cmd_tx_load({"name": "filters.json"})
        with pytest.raises(CommandError, match="нет комментариев"):
            await hub._cmd_comments_load({"name": "tx.json"})
        with pytest.raises(CommandError, match="нет фильтров"):
            await hub._cmd_hw_load({"name": "tx.json"})
    asyncio.run(run())
    assert len(hub.tx.tasks) == 1 and hub.comments


def test_missing_trace_file_is_a_clear_error(tmp_path):
    hub, _ = _hub(tmp_path)
    with pytest.raises(CommandError, match="не существует"):
        asyncio.run(hub._cmd_tracer_open({"name": "нет.trc"}))


def test_rtr_dlc_survives_save_and_load(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()

    async def run():
        await hub._on_rx(CanFrame(1, 0x7E0, bytes(8), rtr=True, timestamp=1.0))
        await hub._cmd_capture_save({"name": "r.trc"})
        await hub._cmd_capture_load({"name": "r.trc"})
    asyncio.run(run())
    f = hub.capture.frame(0)
    assert f.rtr and len(f.data) == 8
    row = hub.capture.rows(0, 1)[0]
    assert row["dlc"] == 8 and row["data"] == ""
    line = (tmp_path / "traces" / "r.trc").read_text(encoding="utf-8").splitlines()[-1].split("\t")
    assert line[4] == "8" and line[5].strip() == ""


def test_local_time_is_when_recording_started(tmp_path):
    t = [datetime(2026, 10, 20, 17, 30, 5, tzinfo=timezone.utc)]
    hub, _ = _hub(tmp_path)
    hub._local_now = lambda: t[0]
    hub.capture._now = hub._local_now
    hub.capture.start()

    async def run():
        await hub._on_rx(CanFrame(1, 0x100, b"\x01", timestamp=1.0))
        t[0] = datetime(2026, 10, 20, 18, 0, 0, tzinfo=timezone.utc)        # сохранили через полчаса
        await hub._cmd_capture_save({"name": "l.trc"})
    asyncio.run(run())
    assert "# $LocalTime=17:30:05.000" in (tmp_path / "traces" / "l.trc").read_text(encoding="utf-8")


def test_tx_counts_at_most_four_per_second(tmp_path):
    hub, sink = _hub(tmp_path)
    clock = [0.0]
    import app.hub as hubmod
    real = hubmod.time.monotonic
    hubmod.time.monotonic = lambda: clock[0]
    try:
        hub._counts_at = hub._stats_at = 0.0
        asyncio.run(hub._cmd_tx_upsert({"task": {"id": "t", "can_id": 0x100}}))
        for k in range(25):                     # секунда тиков по 40 мс, счётчик растёт
            clock[0] = k * 0.04
            hub.tx.tasks[0].count += 1
            hub._tick()
    finally:
        hubmod.time.monotonic = real
    assert len(sink.of("tx_counts")) <= 5


@pytest.mark.parametrize("name,content", [
    ("settings", [1]), ("comments", [["a"]]), ("connection", [1]), ("bitrates", {"a": 1}),
    ("transmit", [{"id": "t", "trigger": "none"}]), ("filters", {"hw": [1], "ranges": ["x"]}), ("tz", 5)])
def test_structurally_wrong_data_files_do_not_crash_startup(tmp_path, name, content):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / f"{name}.json").write_text(json.dumps(content))
    hub, _ = _hub(tmp_path)
    assert hub.hello()["type"] == "hello"


def test_startup_does_not_rewrite_transmit_list(tmp_path):
    (tmp_path / "data").mkdir()
    raw = json.dumps([{"id": "t", "can_id": 256, "data": "01", "extra": "сохранить как есть"}])
    (tmp_path / "data" / "transmit.json").write_text(raw)
    hub, _ = _hub(tmp_path)
    assert len(hub.tx.tasks) == 1
    assert (tmp_path / "data" / "transmit.json").read_text() == raw


def test_opening_another_trace_while_saving_keeps_its_own_name(tmp_path):
    """Ctrl+S большого A.trc, а пока пишется — «Новый»: новый документ не должен
    получить имя A.trc (следующий Ctrl+S перезаписал бы файл)."""
    import threading
    import app.hub as hubmod
    hub, _ = _hub(tmp_path)
    hub.tracer.load(TraceDoc(frames=_frames(5)), "A.trc")
    gate = threading.Event()
    real = hubmod.write_trace

    def slow_write(path, doc, local_time=None):
        gate.wait(5)
        real(path, doc, local_time)

    hubmod.write_trace = slow_write
    try:
        async def run():
            save = asyncio.create_task(hub._cmd_tracer_save({"name": "A.trc"}))
            await asyncio.sleep(0.05)
            await hub._cmd_tracer_new({})
            gate.set()
            await save
        asyncio.run(run())
    finally:
        hubmod.write_trace = real
    assert hub.tracer.name is None and len(hub.tracer.rows) == 0
    assert len(read_trace(tmp_path / "traces" / "A.trc").frames) == 5


def test_two_saves_into_one_file_do_not_corrupt_it(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.capture.start()
    hub.tracer.load(TraceDoc(frames=_frames(3, can_id=0x700)), None)

    async def run():
        for f in _frames(20000):
            hub.capture._push(f)
        return await asyncio.gather(hub._cmd_capture_save({"name": "x.trc"}),
                                    hub._cmd_tracer_save({"name": "x.trc"}), return_exceptions=True)
    results = asyncio.run(run())
    assert all(not isinstance(r, Exception) for r in results), results
    doc = read_trace(tmp_path / "traces" / "x.trc")
    assert len(doc.frames) == 3                       # последним просили сохранить трейс отладчика
    assert not [p for p in (tmp_path / "traces").iterdir() if p.name.endswith(".tmp")]


def test_trigger_on_a_task_that_cannot_send_reports_once_and_keeps_disk_quiet(tmp_path):
    """Задача канала 2 (закрыт) с триггером «Старт» на частом кадре: одно сообщение,
    ни запуска цикла, ни записи списка на диск на каждый кадр."""
    hub, sink = _hub(tmp_path)
    hub.session = FakeSession(info=INFO)
    hub.channels = {1: {"open": True, "listen_only": False}, 2: {"open": False}}
    writes = []
    real_save = hub.store.save
    hub.store.save = lambda name, data: (writes.append(name), real_save(name, data))

    async def run():
        await hub._cmd_tx_upsert({"task": {"id": "t", "channel": 2, "can_id": 0x7E0, "data": "01",
                                           "trigger": {"action": "start", "can_id": 0x120}}})
        writes.clear()
        for k in range(100):
            await hub._on_rx(CanFrame(1, 0x120, b"\x01", timestamp=1.0 + k * 0.01))
        for _ in range(20):
            await asyncio.sleep(0)
    asyncio.run(run())
    toasts = [m for m in sink.of("toast") if m["level"] == "error"]
    assert len(toasts) == 1 and "Канал 2 не открыт" in toasts[0]["message"]
    assert writes.count("transmit") == 0 and hub.tx.tasks[0].running is False


def test_start_on_a_closed_channel_is_refused_up_front(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.session = FakeSession(info=INFO)
    hub.channels = {1: {"open": True, "listen_only": True}}

    async def run():
        await hub._cmd_tx_upsert({"task": {"id": "t", "channel": 1, "can_id": 0x100}})
        with pytest.raises(CommandError, match="Только слушать"):
            await hub._cmd_tx_start({"id": "t"})
    asyncio.run(run())
    assert hub.tx.tasks[0].running is False


def test_string_nan_is_rejected(tmp_path):
    hub, _ = _hub(tmp_path)

    async def run():
        with pytest.raises(CommandError):
            await hub._cmd_bitrates_set({"bitrates": [{"caption": "x", "bitrate": 1, "sample_pct": "NaN",
                                                       "timing": {"prescaler": 1, "seg1": 1, "seg2": 1, "sjw": 1}}]})
        with pytest.raises(CommandError):
            await hub._cmd_tracer_row_add({"row": {"id": 1, "data": "01", "ts": "Infinity"}})
    asyncio.run(run())
    assert hub.bitrates == [] and hub.tracer.rows == []


def test_recording_after_loading_a_file_starts_a_new_stream_and_unsaved_data_is_flagged(tmp_path):
    """F5 после «Загрузить поток»: живые кадры не дописываются к трейсу из файла (в .trc время от
    нуля — получился бы разрыв в часы), а начинается новая запись; несохранённое помечено."""
    from app.can_session import FakeSession
    from app.hub import Hub
    from app.models import CanFrame
    from app.store import JsonStore
    from app.tracefmt import TraceDoc, write_trace

    traces = tmp_path / "traces"
    traces.mkdir()
    write_trace(traces / "old.trc", TraceDoc(frames=[CanFrame(1, 0x100, b"\x01", timestamp=0.5)]), None)
    hub = Hub(lambda *a: FakeSession(), JsonStore(tmp_path / "data"), traces, tmp_path / "data")
    sent = []

    class Ui:
        def send(self, m):
            sent.append(m)

    hub.clients.add(Ui())

    async def run():
        await hub._cmd_capture_load({"name": "old.trc"})
        assert (hub.capture.loaded, hub.capture.dirty, len(hub.capture)) == ("old.trc", False, 1)
        rev = hub.capture_rev
        await hub._cmd_capture_record({"on": True})
        assert hub.capture.recording and len(hub.capture) == 0 and hub.capture.loaded is None
        assert hub.capture_rev == rev + 1                    # вкладки сбрасывают таблицу потока
        assert any(m["type"] == "toast" and "новая запись" in m["message"] for m in sent)
        hub.capture.append(CanFrame(1, 0x200, b"\x02", timestamp=100.0))
        assert hub.capture.dirty
        await hub._cmd_capture_record({"on": False})
        await hub._cmd_capture_save({"name": "new", "format": "trc"})
        assert hub.capture.dirty is False                    # сохранено — можно чистить без вопроса
        await hub._cmd_capture_record({"on": True})          # продолжение своей записи — не сброс
        assert len(hub.capture) == 1
        await hub.shutdown()
    import asyncio
    asyncio.run(run())


def test_a_tsk_file_without_tasks_does_not_wipe_the_transmit_list(tmp_path):
    import asyncio

    import pytest

    from app.can_session import FakeSession
    from app.hub import CommandError, Hub
    from app.store import JsonStore

    hub = Hub(lambda *a: FakeSession(), JsonStore(tmp_path / "data"), tmp_path / "traces", tmp_path / "data")
    lists = tmp_path / "data" / "lists"
    lists.mkdir(parents=True, exist_ok=True)
    (lists / "junk.tsk").write_text("hello world\nnot a task list\n", encoding="utf-8")
    (lists / "empty.tsk").write_text("", encoding="utf-8")

    async def run():
        await hub._cmd_tx_upsert({"task": {"id": "a", "channel": 1, "can_id": 0x7E0, "data": "0201"}})
        with pytest.raises(CommandError, match="нет списка передачи"):
            await hub._cmd_tx_load({"name": "junk.tsk"})
        assert [t.id for t in hub.tx.tasks] == ["a"]                 # список цел
        assert (await hub._cmd_tx_load({"name": "empty.tsk"}))["count"] == 0   # пустой список — это список
        await hub.shutdown()
    asyncio.run(run())


def test_rx_pause_reaches_clients_with_its_reason(tmp_path):
    """«Остановить при получении данных»: клиенты узнают, что пауза — от приёма, и какой
    кадр её вызвал (иначе воспроизведение встаёт без объяснения)."""
    from app.tracer import PlayerConfig

    hub, sink = _hub(tmp_path)
    hub.tracer.load(TraceDoc(frames=_frames(50)), None)
    hub.player.config = PlayerConfig.from_patch(hub.player.config, {"dest": "monitor", "stop_on_rx": True,
                                                                    "delay_mode": "fixed", "fixed_ms": 10})

    async def run():
        await hub._cmd_tracer_play({})
        await asyncio.sleep(0)
        await hub._on_rx(CanFrame(2, 0x7E8, b"\x02", timestamp=1.0))
    asyncio.run(run())
    prog = sink.of("tracer_progress")[-1]
    assert prog["state"] == "paused" and prog["reason"] == "rx"
    assert prog["rx"] == {"ch": 2, "id": 0x7E8, "ext": False}
    assert hub._tracer_state()["reason"] == "rx"


def test_row_edits_tell_the_client_where_the_cursor_goes(tmp_path):
    """Вставка и удаление сдвигают позиции — клиент сбрасывает выделение по новой ревизии.
    Ответ команды несёт эту ревизию и строку для курсора: вставленную; следующую за
    удалёнными (последнюю, если удалён хвост); при правке, спрятавшей строку фильтром ID, —
    следующую за ней."""
    hub, _ = _hub(tmp_path)
    hub.tracer.load(TraceDoc(frames=_frames(10)), None)

    async def run():
        assert await hub._cmd_tracer_rows_delete({"positions": [3]}) == {"rev": hub.tracer_rev, "pos": 3}
        r = await hub._cmd_tracer_rows_delete({"positions": [2, 5]})      # не подряд: за последней удалённой
        assert r == {"rev": hub.tracer_rev, "pos": 4}
        assert (await hub._cmd_tracer_rows_delete({"positions": [5, 6]}))["pos"] == 4   # хвост: новая последняя
        r = await hub._cmd_tracer_row_add({"row": {"id": 0x555, "data": "01"}, "after": 1})
        assert r["pos"] == 2 and r["rev"] == hub.tracer_rev
        rev = hub.tracer_rev
        r = await hub._cmd_tracer_row_edit({"pos": 2, "row": {"id": 0x556, "data": "01"}})
        assert r == {"rev": rev, "pos": 2}                                 # позиции не сдвинулись
        await hub._cmd_tracer_ids_set({"keys": [[1, 0x777, False]], "enabled": False})
        r = await hub._cmd_tracer_row_edit({"pos": 2, "row": {"id": 0x777, "data": "01"}})
        assert r == {"rev": hub.tracer_rev, "pos": 2} and hub.tracer.visible_count() == 5
        r = await hub._cmd_tracer_rows_delete({"positions": list(range(hub.tracer.visible_count()))})
        assert r["pos"] is None
    asyncio.run(run())


def test_tracer_state_tells_a_new_trace_from_an_edit(tmp_path):
    """Подсветку «Найти сообщения» клиент сбрасывает при смене трейса, но не при правке или
    фильтре ID — для этого в состоянии номер трейса (gen)."""
    hub, sink = _hub(tmp_path)

    async def run():
        await hub._cmd_tracer_new({})
        g0 = sink.of("tracer_state")[-1]["gen"]
        await hub._cmd_tracer_row_add({"row": {"id": 0x100, "data": "01"}})
        await hub._cmd_tracer_ids_set({"keys": [[1, 0x100, False]], "enabled": False})
        assert sink.of("tracer_state")[-1]["gen"] == g0
        await hub._cmd_tracer_new({})
        assert sink.of("tracer_state")[-1]["gen"] == g0 + 1
        assert hub.hello()["tracer"]["gen"] == g0 + 1
    asyncio.run(run())
