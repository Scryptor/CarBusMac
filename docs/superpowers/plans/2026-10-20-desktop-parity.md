# Desktop-parity UI (этап 1: CAN-ядро) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Повторить рабочие окна десктопной CarBUS Analyzer (главное окно, монитор, битовая
карта, агрегатор, поток, передача с триггерами, фильтры, каналы/битрейты, отладчик,
настройки, меню и хоткеи) в веб-интерфейсе, удобном на экранах от 1366×768.

**Architecture:** Бэкенд становится одним процессным состоянием (`Hub`), к которому
подключаются WS-клиенты (перезагрузка страницы ничего не рвёт); новые модули: буфер потока,
форматы трейсов (`.trc` десктопа + `.jsonl`), передача с триггерами задач, фильтры,
отладчик, JSON-хранилище в `./data`. Фронт переписывается на Preact + signals с единым
реестром действий (меню/тулбар/контекстные меню/хоткеи) и собственным виртуальным гридом.

**Tech Stack:** Python 3.12 (локально .venv 3.14), FastAPI, carbus-lib 0.1.9, pytest;
TypeScript 5, Vite 6, Preact 10, @preact/signals, lucide-preact, vitest 3,
@testing-library/preact, happy-dom; Playwright (MCP) для проверки раскладки.

**Spec:** `docs/superpowers/specs/2026-10-20-desktop-parity-design.md`
(+ формы `docs/reference/carbus-dfm/`, руководство и `Russian.lng` — см. спек §2).

## Global Constraints

- Вьюпорты проверки: **1366×768**, **1366×650**, **1920×1080**; страница без прокрутки,
  ничего не обрезано, текст ≥ 12 px, контраст текста ≥ 4.5:1.
- Все подписи — русские, из `Russian.lng`; строки живут только в `frontend/src/i18n/ru.ts`.
- Хоткеи десктопа: F2, F3, Ctrl+F3, F4, F5, F8, F9, F12, Ctrl+F12, Ctrl+N, Ctrl+F, Ctrl+↓,
  Enter (передача); отладчик: Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+N, Ins, Ctrl+Ins,
  Ctrl+Enter, Ctrl+Del, Ctrl+C, F5, Ctrl+F5, Shift+F5, F8, F9, Ctrl+F3.
- Значения по умолчанию из DFM: «Сбросить после» 2000 мс (500–10000); период редких данных
  10000 мс (100–10000); период задачи 10 мс (1–10000); задержка триггера 0 (0–10000);
  своя пауза отладчика 100 мс (10–9999); точка выборки 75 % (50–90).
- Время в таблицах: секунды с запятой и 3 знаками («12,453»), относительно первого кадра.
- Тик сервера 40 мс; буфер потока ≤ 5 000 000 кадров.
- Никаких внешних сетевых обращений; мост и UI — только localhost.
- Коммиты — по задаче, в ветке `build/desktop-parity`.

## Review Focus

1. **Перезагрузка страницы во время записи/передачи** — подключение, запись, периодические
   задачи и фильтры продолжают работать, новая вкладка получает полный `hello`
   (тест в Task A9: `test_reconnect_receives_hello_with_live_state`).
2. **Переполнение 32-бит метки прибора** (каждые ~71,6 мин) — время в потоке/трейсе
   монотонно, период в мониторе не уходит в минус (тест в Task A8:
   `test_frames_unwrap_device_timestamp`).
3. **Очень длинная запись** — буфер потока не растёт в памяти неограниченно, на пределе
   запись останавливается с понятным сообщением (тест в Task A3: `test_capture_stops_at_limit`).
4. **Ввод мусора в полях ID/данных/периода** — UI не шлёт команду, подсвечивает поле, бэкенд
   отвечает `ok:false` без разрыва сокета (тесты в Task A9 `test_bad_command_replies_error`
   и Task E1 `parseTaskForm rejects…`).
5. **Трейс десктопа с метками, переходом через минуту и LIN-строками** открывается
   корректно (тест в Task A4: `test_read_trc_wraps_minutes_and_skips_lin`).

---

## Конвенции выполнения (для всех задач)

- Бэкенд-тесты: `cd backend && .venv/bin/pytest -q`; фронт: `cd frontend && npx vitest run`
  и `npx tsc --noEmit -p .` и `npx vite build`.
- **UI-проверка** (во всех задачах с UI, шаг «Проверить в браузере»):
  1. `cd frontend && npx vite build`;
  2. `cd backend && .venv/bin/python -m app.demo --port 8765` (фоном);
  3. Playwright: `browser_resize` 1366×768 → `browser_navigate http://127.0.0.1:8765/` →
     действия задачи → `browser_take_screenshot` → **посмотреть скриншот**;
  4. `browser_evaluate` с содержимым `frontend/scripts/layout-audit.js` → в отчёте
     `pageOverflowX/Y = 0`, пустые `clipped` и `smallText`;
  5. повторить 3–4 на 1366×650; 6. остановить демо-сервер, удалить скриншоты.
  Найденные дефекты раскладки исправляются в той же задаче.

---

## Milestone A — Бэкенд

### Task 1 (A1): Модель кадра, JSON-хранилище, настройки

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/app/store.py`, `backend/app/settings.py`
- Test: `backend/tests/test_store.py`, `backend/tests/test_settings.py`

**Interfaces:**
- Produces: `CanFrame(..., direction: str = "rx")`;
  `JsonStore(root: Path)` с `load(name: str, default: Any) -> Any` и `save(name: str, data: Any) -> None`
  (атомарно: tmp + `os.replace`); `DEFAULT_SETTINGS: dict`;
  `merge_settings(current: dict, patch: dict) -> dict` (неизвестные ключи игнорируются,
  числа зажимаются в диапазоны, типы приводятся к типу дефолта).
- `DEFAULT_SETTINGS` ключи: `theme="system"`, `grid_font="SF Mono"`, `grid_font_size=13 (11..18)`,
  `mark_changed=True`, `mark_color="#e0a526"`, `mark_hold_ms=2000 (500..10000)`,
  `aggregator=False`, `rare_mode=False`, `rare_period_ms=10000 (100..10000)`,
  `monitor_hex_ids=True`, `monitor_sort=False`, `monitor_group_by_channel=False`,
  `restore_tx_on_start=True`, `tracer_max_1s=False`, `copy_header=True`,
  `copy_id_hex=True`, `copy_data_hex=True`, `filter_new_active=True`,
  `filter_restore_on_start=True`, `filter_simple_mode=False`, `log_autostart=False`,
  `log_record_tx=True`, `log_name_mask="%Y-%m-%d_%H-%M-%S"`,
  `log_meta={"transport":"","brand":"","model":"","body":"","year":""}`.

- [ ] **Step 1: Write the failing tests**

```python
def test_store_roundtrip_and_default(tmp_path):
    s = JsonStore(tmp_path)
    assert s.load("x", {"a": 1}) == {"a": 1}
    s.save("x", {"a": 2})
    assert JsonStore(tmp_path).load("x", None) == {"a": 2}
    assert not list(tmp_path.glob("*.tmp"))

def test_store_corrupt_file_falls_back_to_default(tmp_path):
    (tmp_path / "x.json").write_text("{broken")
    assert JsonStore(tmp_path).load("x", 7) == 7

def test_merge_settings_clamps_and_ignores_unknown():
    s = merge_settings(DEFAULT_SETTINGS, {"mark_hold_ms": 50, "nope": 1, "grid_font_size": "40"})
    assert s["mark_hold_ms"] == 500 and s["grid_font_size"] == 18 and "nope" not in s

def test_frame_direction_defaults_to_rx():
    assert CanFrame(1, 0x100).direction == "rx"
```

- [ ] **Step 2: Run, expect FAIL** (`ImportError`).
- [ ] **Step 3: Implement** `JsonStore` (UTF-8 JSON, `indent=1`), `settings.py` с таблицей
  диапазонов `RANGES = {"grid_font_size": (11,18), "mark_hold_ms": (500,10000),
  "rare_period_ms": (100,10000)}`; поле `direction` в `CanFrame`.
- [ ] **Step 4: Run, expect PASS** (вся папка tests зелёная).
- [ ] **Step 5: Commit** `feat(backend): json store, settings defaults, frame direction`.

### Task 2 (A2): Монитор — флаги, стабильность байт, агрегатор уникальных данных

**Files:**
- Modify: `backend/app/monitor.py`, `backend/app/schemas.py`
- Test: `backend/tests/test_monitor.py` (дополнить)

**Interfaces:**
- Produces: `MonitorRow` + поля `rtr, fd, brs: bool`, `stable_ms: list[float | None]`
  (на байт: сколько мс байт был неизменен до своего последнего изменения; `None` — не менялся),
  `fc: int` (число уникальных payload; 0 при выключенном агрегаторе);
  `MonitorState(aggregator: bool = False, unique_cap: int = 4096)`;
  `.snapshot_all() -> list[MonitorRow]`; `.unique_frames(ch: int, can_id: int, ext: bool) -> list[UniqueFrame]`
  где `UniqueFrame(data: bytes, count: int, period_ms: float | None, last_ts: float)`;
  `.set_aggregator(on: bool)`; `row_to_dict(r)` → ключи
  `ch,id,ext,rtr,fd,brs,dlc,data,count,period_ms,changed,stable_ms,fc,ts`.

- [ ] **Step 1: Write the failing tests**

```python
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

def test_aggregator_counts_unique_payloads_and_caps():
    m = MonitorState(aggregator=True, unique_cap=2)
    for i, d in enumerate([b"\x01", b"\x02", b"\x01", b"\x03"]):
        m.update(CanFrame(1, 0x20, d, timestamp=i * 0.1))
    r = m.snapshot_delta()[0]
    assert r.fc == 2                     # третий уникальный не влез в cap
    u = m.unique_frames(1, 0x20, False)
    assert [x.data for x in u] == [b"\x01", b"\x02"] and u[0].count == 2

def test_snapshot_all_returns_every_row_without_consuming_delta():
    m = MonitorState(); m.update(CanFrame(1, 1, b"\x00", timestamp=0))
    assert len(m.snapshot_all()) == 1 and len(m.snapshot_delta()) == 1
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**: в `_Entry` хранить `first_ts`, `byte_change_ts: list[float|None]`,
  `stable_ms: list[float|None]`, `uniq: dict[bytes, UniqueFrame]` (только при агрегаторе);
  при изменении байта `i` в `update`: `stable = (ts - (byte_change_ts[i] or first_ts)) * 1000`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(backend): monitor flags, byte stability, unique-data aggregator`.

### Task 3 (A3): Буфер потока (capture)

**Files:**
- Create: `backend/app/capture.py`
- Test: `backend/tests/test_capture.py`

**Interfaces:**
- Produces: `Marker(index: int, label: str, comment: str, auto: bool = False)`;
  `Capture(limit: int = 5_000_000)` с `recording: bool`, `full: bool`, `t0: float | None`,
  `start()`, `pause()`, `clear()`, `append(f: CanFrame) -> bool` (False если не пишем/полон),
  `__len__`, `frame(i) -> CanFrame`, `rows(start: int, count: int) -> list[dict]`
  (ключи `i,t,ch,dir,id,ext,rtr,dlc,data,marker`; `t` — сек от `t0`),
  `add_marker(label, comment, auto=False) -> Marker` (на индекс `len(self)`),
  `markers: list[Marker]`, `frames() -> list[CanFrame]`,
  `load(frames: list[CanFrame], markers: list[Marker]) -> None`, `duration_s() -> float`.
- Хранение колоночное: `array('d')` ts, `array('B')` ch/flags/dlc, `array('I')` id,
  `bytearray` по 8 байт на кадр + `dict[int, bytes]` для payload > 8.

- [ ] **Step 1: Write the failing tests**

```python
def test_capture_appends_only_while_recording():
    c = Capture(); assert not c.append(CanFrame(1, 1, b"\x01", timestamp=1.0))
    c.start(); assert c.append(CanFrame(1, 1, b"\x01", timestamp=1.0))
    c.append(CanFrame(2, 0x18DAF110, b"\x02\x7e\x00", extended=True, timestamp=1.5, direction="tx"))
    rows = c.rows(0, 10)
    assert [r["t"] for r in rows] == [0.0, 0.5] and rows[1]["dir"] == "tx" and rows[1]["ext"]

def test_marker_attaches_to_next_row():
    c = Capture(); c.start(); c.append(CanFrame(1, 1, timestamp=0))
    c.add_marker("A", "note"); c.append(CanFrame(1, 2, timestamp=1))
    assert c.rows(1, 1)[0]["marker"] == {"label": "A", "comment": "note"}

def test_capture_stops_at_limit():
    c = Capture(limit=3); c.start()
    for i in range(5): c.append(CanFrame(1, i, timestamp=i))
    assert len(c) == 3 and c.full and not c.recording

def test_capture_append_200k_is_fast():
    c = Capture(); c.start(); t = time.perf_counter()
    for i in range(200_000): c.append(CanFrame(1, i & 0x7FF, b"\x01\x02\x03\x04\x05\x06\x07\x08", timestamp=i / 1e4))
    assert time.perf_counter() - t < 2.0 and c.frame(199_999).data[7] == 8
```

- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(backend): columnar stream capture with markers`.

### Task 4 (A4): Форматы трейсов (`.trc` десктопа v3 и `.jsonl`)

**Files:**
- Create: `backend/app/tracefmt.py`, `backend/tests/fixtures/desktop_v3.trc`
- Modify: `backend/app/trace.py` (оставить `TraceWriter` для фонового лога, ридер → tracefmt)
- Test: `backend/tests/test_tracefmt.py`

**Interfaces:**
- Produces: `TraceDoc(frames: list[CanFrame], markers: list[Marker], comments: dict[int, str], meta: dict[str, str], skipped: int = 0)`;
  `read_trace(path: Path) -> TraceDoc` (по расширению `.trc`/`.jsonl`, иначе `ValueError`);
  `write_trace(path: Path, doc: TraceDoc) -> None`; `parse_trc(text: str) -> TraceDoc`;
  `format_trc(doc: TraceDoc, local_time: datetime | None = None) -> str`;
  `parse_jsonl(text: str) -> TraceDoc`; `format_jsonl(doc: TraceDoc) -> str`
  (строка-заголовок `{"meta": …, "markers": […]}` первой строкой + по строке на кадр с
  `ts, ts_source, ch, id, ext, rtr, dlc, data, dir, comment`).
- Формат `.trc` — спек §8: строка 1 `@ TEXT @ 3 @ 64 @ 0 @ {N} @ {dur_ms} @ {Nd }hh:mm:ss.mmm @`,
  `# $LocalTime=HH:MM:SS.mmm`, метка `------\t{label}\t{comment}`, кадр
  `f"{s:02d},{us:06d}\t{ch}\t{flags:08x}\t{id}\t{dlc}\t{data:<23}\t00000000\t{ascii}\t{comment}"`,
  `id` — HEX верхним регистром, 3 цифры (11 бит) или 8 (29 бит), `flags = 0x4 | ext | rtr<<1`,
  `ascii` — печатные 0x20–0x7E, прочее `.`; CRLF.

- [ ] **Step 1: Fixture** `desktop_v3.trc` (CRLF):

```
@ TEXT @ 3 @ 64 @ 0 @ 5 @ 61500 @ 00:01:01.500 @
# $LocalTime=10:20:30.000
59,500000	1	00000004	1AA	2	01 02	00000000	..	first
------	M1	marker note
59,900000	2	00000005	18DAF110	3	02 7E 00	00000000	.~.	
00,100000	1	00000004	1AB	1	FF	00000000	.	
00,200000	3	00000100	3C	0		00000000		lin
01,000000	1	00000006	7E0	0		00000000		rtr
```

- [ ] **Step 2: Write the failing tests**

```python
def test_read_trc_wraps_minutes_and_skips_lin():
    d = parse_trc(FIXTURE.read_text())
    assert [f.can_id for f in d.frames] == [0x1AA, 0x18DAF110, 0x1AB, 0x7E0]
    assert [round(f.timestamp, 3) for f in d.frames] == [59.5, 59.9, 60.1, 61.0]
    assert d.frames[1].extended and d.frames[3].rtr and d.skipped == 1
    assert d.markers == [Marker(1, "M1", "marker note")] and d.comments[0] == "first"
    assert d.meta["$LocalTime"] == "10:20:30.000"

def test_trc_roundtrip_is_stable():
    d = parse_trc(FIXTURE.read_text())
    again = parse_trc(format_trc(d))
    assert [(f.channel, f.can_id, f.data, f.extended, f.rtr) for f in again.frames] == \
           [(f.channel, f.can_id, f.data, f.extended, f.rtr) for f in d.frames]
    assert [round(f.timestamp - again.frames[0].timestamp, 6) for f in again.frames] == \
           [round(f.timestamp - d.frames[0].timestamp, 6) for f in d.frames]

def test_trc_header_line_matches_desktop_layout():
    line = format_trc(parse_trc(FIXTURE.read_text())).split("\r\n")[0]
    parts = [p.strip() for p in line.split("@")]
    assert len(parts) == 9 and parts[1:4] == ["TEXT", "3", "64"] and parts[5] == "4"

def test_trc_unsupported_version_is_explicit():
    with pytest.raises(ValueError, match="версия"):
        parse_trc("@ TEXT @ 2 @ 64 @ 0 @ 0 @ 0 @ 00:00:00.000 @\r\n")

def test_jsonl_roundtrip_keeps_direction_and_markers(): ...
```

- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement**; время при записи: `us_total = round((ts - t_first) * 1e6) % 60_000_000`.
- [ ] **Step 5: Run, expect PASS. Commit** `feat(backend): desktop .trc v3 and jsonl trace formats`.

### Task 5 (A5): Передача — задачи, счётчики, триггеры задач

**Files:**
- Modify: `backend/app/transmit.py`
- Test: `backend/tests/test_transmit.py` (переписать под новую модель)

**Interfaces:**
- Produces:
  `TriggerSpec(action: str = "none", delay_ms: int = 0, channel: int = 0, can_id: int | None = None, ext: bool = False, dlc: int | None = None, data: list[int | None] = 8×None)`;
  `TxTask(id: str, channel: int = 1, can_id: int = 0, ext: bool = False, rtr: bool = False, data: bytes = b"", period_ms: int = 10, comment: str = "", running: bool = False, count: int = 0, trigger: TriggerSpec = TriggerSpec())`;
  `task_to_dict(t) / task_from_dict(d)` (JSON-формат как в спеке: `data` — hex, `trigger.data` — список);
  `TransmitManager(send: Callable[[CanFrame], Awaitable[None]], sleep=asyncio.sleep, on_change: Callable[[], None] = lambda: None)`
  с `tasks: list[TxTask]`, `upsert(task)`, `delete(id)`, `clear()`, `async send_once(id)`,
  `start(id)`, `pause(id)`, `start_all()`, `pause_all()`, `reset(id: str | None)`,
  `async on_frame(f: CanFrame)`, `to_list() -> list[dict]`, `load_list(items: list[dict])`.
- Правила: `send_once` и цикл увеличивают `count`; триггер срабатывает, если
  `channel in (0, f.channel)`, `can_id == f.can_id and ext == f.extended`,
  `dlc is None or dlc == len(f.data)`, каждый неп`None` байт совпадает; действие —
  через `delay_ms` (через инъектированный `sleep`): `single` → `send_once`, `start`, `stop` → `pause`;
  кадры с `direction == "tx"` триггеры не запускают.

- [ ] **Step 1: Write the failing tests** (на `FakeSession`-подобный `sent` список и fake sleep)

```python
async def test_send_once_counts_and_sends(): ...      # count == 1, sent[0].can_id == task.can_id
async def test_periodic_loop_uses_period(): ...       # sleep вызван с 0.01 при period_ms=10
async def test_trigger_single_with_dont_care_bytes():
    sent = []; tm = TransmitManager(send=_collect(sent), sleep=_nosleep)
    tm.upsert(TxTask(id="t", can_id=0x321, data=b"\x01",
                     trigger=TriggerSpec(action="single", can_id=0x123, data=[0x10, None] + [None]*6)))
    await tm.on_frame(CanFrame(1, 0x123, b"\x10\x99"))
    await tm.on_frame(CanFrame(1, 0x123, b"\x11\x99"))
    await asyncio.sleep(0)
    assert [f.can_id for f in sent] == [0x321]
async def test_trigger_start_and_stop_control_cycle(): ...
async def test_trigger_respects_delay(): ...          # sleep получил 0.25 при delay_ms=250
async def test_tx_frames_do_not_fire_triggers(): ...
def test_task_dict_roundtrip(): ...
```

- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(backend): transmit tasks with counters and per-task triggers`.

### Task 6 (A6): Фильтры — аппаратные слоты и программные диапазоны

**Files:**
- Create: `backend/app/filters.py`
- Test: `backend/tests/test_filters.py`

**Interfaces:**
- Produces: `HwSlot(channel: int, index: int, enabled: bool = False, can_id: int = 0, mask: int = 0x7FF, ext: bool = False)`;
  `HwFilters(layout: dict[int, int])` (`slots: list[HwSlot]`, `set(slot)`, `first_free(channel) -> HwSlot | None`,
  `to_list()`, `load_list(items)`, `layout_from_device(info: dict) -> dict[int, int]` — из
  `filters_info` (`size` по каналу), по умолчанию `{1: 14, 2: 14}`);
  `RangeExclusion(enabled: bool = True, can_id: int = 0, mask: int = 0x7FF)`;
  `RangeFilter(id: str, channel: int, enabled: bool = True, start: int = 0, end: int = 0x7FF, exclusions: list[RangeExclusion])`;
  `SoftFilters` (`ranges`, `upsert(r)`, `delete(id)`, `accept(f: CanFrame) -> bool`, `to_list()`, `load_list()`).
- `accept`: нет включённых диапазонов канала → True; иначе True, если ID в каком-то
  включённом диапазоне и не попадает ни под одно включённое исключение
  (`(id & mask) == (ex.can_id & mask)`).

- [ ] **Step 1: Failing tests**: `test_accept_without_ranges_passes_all`,
  `test_range_with_exclusion_by_mask` (0x100–0x1FF, искл. 0x120/0x7F0 → 0x125 отбрасывается,
  0x130 проходит, 0x200 отбрасывается), `test_disabled_range_ignored`,
  `test_layout_from_device_info` (`{"filters_info":[{"channel":1,"size":13},{"channel":2,"size":16}]}` → `{1:13,2:16}`),
  `test_first_free_slot`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(backend): hardware filter slots and software range filters`.

### Task 7 (A7): Отладчик — документ трейса и проигрыватель

**Files:**
- Create: `backend/app/tracer.py`
- Test: `backend/tests/test_tracer.py`

**Interfaces:**
- Produces: `TraceRow(frame: CanFrame, enabled: bool = True, bp: bool = False, before_ms: int = 0, after_ms: int = 0, comment: str = "")`;
  `TracerDoc` — `name: str | None`, `rows: list[TraceRow]`, `markers: list[Marker]`, `modified: bool`,
  `load(doc: TraceDoc, name: str | None)`, `to_trace_doc() -> TraceDoc`, `rows_view(start, count) -> list[dict]`
  (ключи `i,t,ch,dir,id,ext,rtr,dlc,data,enabled,bp,before_ms,after_ms,comment,marker`),
  `ids() -> list[dict]` (`ch,id,ext,count,enabled`), `set_ids_enabled(keys: list[tuple[int,int,bool]], on: bool)`,
  `add(row, index: int | None)`, `edit(index, row)`, `delete(indices)`,
  `set_enabled(indices, on)`, `set_enabled_by_id(key, on)`, `set_bp(index, on)`, `channels() -> list[int]`;
  `PlayerConfig(delay_mode: str = "timestamp", fixed_ms: int = 10, max_1s: bool = False, loop: bool = False, dest: str = "ch1", only_channel: int | None = None, stop_on_bp: bool = True, stop_on_rx: bool = False)`;
  `TracePlayer(doc, send: Callable[[CanFrame, str], Awaitable[None]], sleep, on_progress: Callable[[int, str], None])`
  с `state: "stopped"|"playing"|"paused"`, `current: int | None`, `config`,
  `async play(selection: list[int] | None = None)`, `pause()`, `stop()`, `async step()`, `notify_rx()`.
- Правила: строка играется, если `enabled`, её ID включён в таблице ID и
  (`only_channel is None or ch == only_channel`); пауза перед строкой =
  `before_ms` + (разница меток, при `max_1s` ≤ 1 с | `fixed_ms`) ; после — `after_ms`;
  `stop_on_bp` → пауза **перед** строкой с `bp`; `stop_on_rx` → `notify_rx()` ставит паузу;
  `loop` → по кругу; `dest`: `ch1`/`ch2` переписывает канал кадра, `monitor` — в монитор.

- [ ] **Step 1: Failing tests**: `test_play_respects_timestamp_delays_and_max_1s`,
  `test_fixed_delay_mode`, `test_disabled_rows_and_ids_are_skipped`,
  `test_pauses_before_breakpoint_and_resumes`, `test_stop_on_rx_pauses`,
  `test_selection_plays_only_selected`, `test_step_advances_one_playable_row`,
  `test_dest_channel_rewrites_frame_channel`, `test_edit_ops_mark_modified`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(backend): tracer document and player`.

### Task 8 (A8): Сессия прибора — тайминги, терминатор, слоты фильтров, развёртка времени

**Files:**
- Modify: `backend/app/can_session.py`, `backend/app/carbus_session.py`
- Test: `backend/tests/test_can_session.py`, `backend/tests/test_carbus_session_api.py`

**Interfaces:**
- Produces (протокол `CanSession` и `FakeSession`):
  `open_channel(channel: int, bitrate: int | None, listen_only: bool, timing: dict | None = None)`
  (`timing = {"prescaler","seg1","seg2","sjw"}` → `open_can_channel_custom(CanTiming(...))`),
  `set_terminator(channel: int, enabled: bool)`, `clear_hw_filter(channel: int, index: int)`;
  `get_device_info()` дополнительно отдаёт `filters_info`.
  `CarbusSession.frames()` разворачивает 32-битные мкс: `ts = (wraps * 2**32 + raw) / 1e6`.
  `FakeSession` получает `terminators: dict`, `cleared: list` для тестов.

- [ ] **Step 1: Failing tests**: `test_frames_unwrap_device_timestamp` (сырые
  `0xFFFF_FF00`, `0x0000_0100` → второй ts > первого на 512 мкс),
  `test_open_channel_with_timing_uses_custom_api`, `test_set_terminator_calls_device`,
  `test_clear_hw_filter_calls_device`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(backend): custom timing, terminator, filter slot clear, timestamp unwrap`.

### Task 9 (A9): Hub, протокол WS, файлы, демо-источник

**Files:**
- Create: `backend/app/hub.py`, `backend/app/demo.py`
- Modify: `backend/app/server.py`, `docker-compose.yml` (том `./data:/app/data`), `.gitignore` (`data/`)
- Test: `backend/tests/test_hub.py`, `backend/tests/test_server.py` (переписать)

**Interfaces:**
- Consumes: всё из A1–A8.
- Produces: `Hub(factory, store: JsonStore, traces_dir: Path, data_dir: Path, sleep=asyncio.sleep)`;
  `async Hub.attach(client) / detach(client)`, `async Hub.handle(client, msg: dict)`;
  `create_app(factory, *, data_dir: Path | None = None, traces_dir: Path | None = None) -> FastAPI`
  (пути по умолчанию из env `CARBUS_DATA`, `CARBUS_TRACES`, иначе `<repo>/data`, `<repo>/traces`).
- **Команды** (все принимают `req_id`; ответ `{"type":"reply","req_id","ok":true,"data":…}`
  или `{"type":"reply","req_id","ok":false,"error":"…"}`; без `req_id` ошибка → событие `error`):
  `connect {config}` (`config = {bridge_host, bridge_port, channels:[{channel, alias, bitrate, timing, listen_only, terminator, auto_open}]}`,
  сохраняется в `connection.json`), `disconnect`, `channel_terminator {channel, enabled}`,
  `monitor_clear`, `monitor_frames {ch,id,ext}` → `{rows:[{data,count,period_ms,ts}]}`,
  `comment_set {id, ext, text}`, `comments_clear`, `comments_save {name}`, `comments_load {name, append}`,
  `settings_set {patch}`, `capture_record {on}`, `capture_clear`, `capture_rows {start,count}` → `{rows}`,
  `capture_marker {label, comment, auto}`, `capture_save {name, format: "trc"|"jsonl"}` → `{name}`,
  `capture_load {name}`, `capture_to_tracer`, `tx_upsert {task}`, `tx_delete {id}`, `tx_clear`,
  `tx_send {id}`, `tx_start {id}`, `tx_pause {id}`, `tx_start_all`, `tx_pause_all`,
  `tx_reset {id|null}`, `tx_save {name}`, `tx_load {name}`, `hw_set {slot}`, `hw_save {name}`,
  `hw_load {name}`, `range_upsert {filter}`, `range_delete {id}`, `filters_add_id {channel,id,ext}`,
  `tracer_new`, `tracer_open {name}`, `tracer_save {name|null, format}`, `tracer_rows {start,count}`,
  `tracer_ids`, `tracer_ids_set {keys, enabled}`, `tracer_row_add {row, index}`,
  `tracer_row_edit {index,row}`, `tracer_rows_delete {indices}`,
  `tracer_rows_enable {indices|null, key|null, enabled}`, `tracer_bp {index, on}`,
  `tracer_comment {index,text}`, `tracer_config {patch}`, `tracer_play {selection}`,
  `tracer_pause`, `tracer_stop`, `tracer_step`, `files_list {kind:"traces"|"lists"}` →
  `{files:[{name,size,mtime}]}`.
- **События**: `hello {status, settings, comments, monitor:[rows], capture, tx, filters, tracer, connection, bitrates}`,
  `status {state:"closed"|"opening"|"opened"|"error", message, device_info, channels}`,
  `monitor_delta {rows}`, `monitor_reset`, `capture_state {recording, count, duration_s, full, markers}`,
  `capture_tail {start, rows}` (последние ≤ 100 строк, только при изменении),
  `tx_state {tasks}`, `tx_counts {counts:{id:n}}` (≤ 4 Гц), `filters_state {hw, hw_layout, ranges}`,
  `settings {settings}`, `comments {comments:{"<id>:<0|1>": text}}`,
  `tracer_state {name, modified, count, channels, state, current, config}`,
  `tracer_progress {current, state}`, `toast {level, message}`, `error {message}`.
- Конвейер приёма: кадр → `SoftFilters.accept` → монитор → `capture.append` → фоновый лог →
  `tx.on_frame` → `player.notify_rx`. TX-кадры (передача и отладчик в канал) идут в
  `capture` и лог с `direction="tx"` и меткой «время прибора ≈ последняя RX-метка + прошедшее».
- REST: `GET /api/files/{kind}/{name}` (скачивание), `POST /api/files/{kind}?name=` (загрузка тела),
  имена — только basename, расширения `.trc/.jsonl/.json/.txt`.
- `python -m app.demo --port N`: Hub с сессией-генератором (4 ID на CH1/CH2 как в
  `scratchpad/fake_server.py`, меняющиеся байты, 29-бит ID, + отвечает на TX `0x7E0` кадром `0x7E8`).

- [ ] **Step 1: Failing tests** (TestClient WS):
  `test_hello_snapshot_on_attach`, `test_reply_matches_req_id`,
  `test_bad_command_replies_error` (неизвестный тип и битые поля → `ok:false`, сокет жив),
  `test_reconnect_receives_hello_with_live_state` (подключиться, `capture_record on`,
  `tx_upsert`+`tx_start`, закрыть WS, открыть новый → `hello.capture.recording` и
  `hello.tx.tasks[0].running` истинны), `test_soft_filter_drops_before_monitor_and_capture`,
  `test_tx_frames_enter_capture_as_tx`, `test_capture_save_and_load_trc`,
  `test_files_upload_download_rejects_traversal`, `test_settings_persist_to_store`.
- [ ] **Step 2–4:** FAIL → implement → PASS (вся папка tests зелёная, старые тесты
  сервера переписаны под новый протокол).
- [ ] **Step 5: Commit** `feat(backend): process-wide hub, ws protocol v2, files api, demo source`.

---

## Milestone B — Фронт: основа

### Task 10 (B1): Инструменты, WS-клиент v2, стор, строки, форматирование

**Files:**
- Modify: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`
- Create: `frontend/src/core/ws.ts`, `frontend/src/core/store.ts`, `frontend/src/i18n/ru.ts`,
  `frontend/src/core/format.ts`, `frontend/scripts/layout-audit.js`
- Delete: старые `frontend/src/{app,main,monitor,bitmap,stream,filters,transmit,tracer,ws}.ts`,
  `frontend/src/style.css` (функции, которые остаются нужны, переносятся в `core/format.ts`,
  `lib/timing.ts`, `lib/bits.ts`)
- Test: `frontend/tests/ws.test.ts`, `frontend/tests/format.test.ts`

**Interfaces:**
- Produces: `WsClient(url)` — `connect()`, `on(type, fn) -> () => void`,
  `request<T>(cmd: Record<string, unknown>, timeoutMs = 10000): Promise<T>` (req_id = счётчик,
  отклоняется на `ok:false` с `Error(error)`), `send(cmd)`, авто-переподключение с backoff
  250 мс → 5 с; `connectionState` signal `"connecting"|"open"|"closed"`.
- `format.ts`: `fmtId(id: number, ext: boolean, hex: boolean): string` (HEX: 3/8 цифр без
  `0x`, верхний регистр; DEC — десятичное), `fmtData(hex: string): string[]`,
  `fmtAscii(hex: string): string`, `fmtTime(sec: number): string` («12,453»),
  `fmtPeriod(ms: number | null): string` («19,999» в мс с 3 знаками), `fmtFlags(row): string`
  («CAN», «CAN EXT», «RTR»), `parseHexId(s: string, ext: boolean): number` (бросает `Error` по-русски).
- `ru.ts`: объект `t` со строками меню, хинтов, колонок, диалогов (из `Russian.lng`).
- `vite.config.ts`: Preact JSX (`esbuild.jsx: "automatic", jsxImportSource: "preact"`),
  proxy `/ws` и `/api` → `http://127.0.0.1:8765` для `npm run dev`; vitest `environment: "happy-dom"`
  для `tests/**/*.test.tsx`.
- `layout-audit.js`: одно выражение-функция `() => ({pageOverflowX, pageOverflowY, clipped, smallText})`,
  где `clipped` — видимые элементы с `scrollWidth > clientWidth + 1` у текстовых полей/кнопок
  или выходящие за вьюпорт, `smallText` — элементы с текстом и `font-size < 12px`.

- [ ] **Step 1: Failing tests**: `request resolves on matching reply and rejects on ok:false`,
  `request times out`, `fmtId hex/dec widths`, `fmtTime uses comma and 3 decimals`,
  `fmtAscii replaces non-printables`, `parseHexId rejects out-of-range 11-bit`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npx tsc --noEmit -p .` чисто.
- [ ] **Step 5: Commit** `feat(frontend): preact tooling, ws client v2, store, ru strings, formatters`.

### Task 11 (B2): UI-примитивы, темы, реестр действий и хоткеи

**Files:**
- Create: `frontend/src/styles/{tokens,base,components}.css`, `frontend/src/ui/{Menu,MenuBar,ContextMenu,Dialog,FloatingWindow,Toolbar,Tabs,Splitter,Fields,Tooltip}.tsx`,
  `frontend/src/core/actions.ts`, `frontend/src/core/hotkeys.ts`
- Test: `frontend/tests/actions.test.ts`, `frontend/tests/hotkeys.test.ts`, `frontend/tests/ui.test.tsx`

**Interfaces:**
- Produces: `Action = {id: string, label: string, hint?: string, shortcut?: string, icon?: IconName, enabled?: () => boolean, checked?: () => boolean, run: () => void}`;
  `registerActions(view: "main"|"tracer"|"global", list: Action[]): () => void`, `getAction(id)`,
  `runAction(id)`; `hotkeys.ts`: `normalizeKey(e: KeyboardEvent): string` («Ctrl+F3»,
  «Ctrl+ArrowDown», «Shift+F5», «Insert»), `installHotkeys(getView: () => "main"|"tracer")`
  (в полях ввода срабатывают только F-клавиши и Ctrl-сочетания; `preventDefault` при срабатывании).
- Компоненты: `<MenuBar menus={[{label, items: MenuItem[]}]}/>`, `MenuItem = {action: string} | {separator: true} | {label, items}`
  (подпись, хоткей справа, флажок для checked, disabled); `openContextMenu(x, y, items)`;
  `<Dialog title onClose footer>`; `<FloatingWindow id title onClose>` (перетаскивание за
  заголовок, удержание в пределах вьюпорта, позиция в localStorage); `<ToolButton action>`
  (иконка lucide + тултип «Подсказка (хоткей)»); `<Splitter dir onResize>`; поля
  `<HexField>`, `<NumberField min max>`, `<ByteCells value onChange count=8 allowEmpty>`.
- `tokens.css`: переменные для светлой и тёмной темы (`:root[data-theme=light|dark]`,
  «как в ОС» — через `prefers-color-scheme`), шрифты `--ui-font` (system-ui 13px),
  `--grid-font`/`--grid-size` (из настроек), `--mark` (цвет подсветки).

- [ ] **Step 1: Failing tests**: `normalizeKey maps F-keys and modifiers`,
  `hotkey in input fires only for F-keys and Ctrl combos`, `disabled action is not run`,
  `tracer view overrides main bindings for F5/Ctrl+N`, `context menu renders separators and disabled items` (компонентный).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(frontend): ui primitives, themes, action registry, hotkeys`.

### Task 12 (B3): Виртуальный грид

**Files:**
- Create: `frontend/src/ui/grid/{VirtualGrid.tsx,gridMath.ts,selection.ts}`
- Test: `frontend/tests/gridMath.test.ts`, `frontend/tests/selection.test.ts`

**Interfaces:**
- Produces: `visibleRange(scrollTop: number, viewport: number, rowH: number, total: number, overscan = 6): {first: number, last: number}`;
  `Selection` с `click(i)`, `shiftClick(i)`, `ctrlClick(i)`, `selected(): number[]`, `anchor`;
  `<VirtualGrid columns rowCount rowHeight getRow(i) renderCell(col,row,i) selection onContextMenu onActivate follow?>`;
  `Column = {key, title, width, minWidth?, align?, resizable?}`; ширины колонок сохраняются
  в localStorage по `gridId`; `follow` — автопрокрутка к концу, пока пользователь внизу;
  `refresh(rows?: number[])` — точечная перерисовка без перерендера всего дерева.
- [ ] **Step 1–4:** тесты `visibleRange clamps`, `shift range`, `ctrl toggle` → implement → PASS.
- [ ] **Step 5: Commit** `feat(frontend): virtual grid with selection and resizable columns`.

### Task 13 (B4): Каркас главного окна

**Files:**
- Create: `frontend/src/main.tsx`, `frontend/src/app/{App,MainMenu,MainToolbar,StatusBar,Workspace}.tsx`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: B1–B3. Produces: раскладка — меню 28 px, тулбар 38 px, рабочая область
  (приём сверху, сплиттер, док передачи снизу 270 px по умолчанию, панель фильтров справа
  340 px), статусбар 24 px; вид `"main" | "tracer"` (signal `view`); слоты для фич
  (`ReceiveArea`, `TransmitDock`, `FiltersPanel`, `TracerView`) — пока заглушки;
  статусбар: «● Подключено/Не подключен/Соединение…», `HW_CH32 2.2.3.57 №6950`,
  каналы «К1 500k · К2 закрыт», «Запись N 00:00:10», «RX N к/с».
- [ ] **Step 1:** компонентный тест `status bar shows device and channel states from status event`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Проверить в браузере** (конвенция) — каркас без обрезаний на 1366×768/650.
- [ ] **Step 6: Commit** `feat(frontend): main window shell`.

---

## Milestone C — Приём

### Task 14 (C1): Монитор

**Files:**
- Create: `frontend/src/features/monitor/{monitorModel.ts,highlight.ts,MonitorGrid.tsx,ReceiveArea.tsx,CommentDialog.tsx,RarePeriodDialog.tsx,actions.ts}`
- Test: `frontend/tests/monitorModel.test.ts`, `frontend/tests/highlight.test.ts`, `frontend/tests/monitor.test.tsx`

**Interfaces:**
- `monitorModel.ts`: `MonitorStore` — `apply(rows: MonitorRowJson[])`, `reset()`,
  `order(sort: boolean, group: boolean): Key[]` (без сортировки — порядок появления),
  `get(key)`; `Key = "ch:id:ext"`.
- `highlight.ts`: `markUntil(row, prev, now: number, s: {mark_changed, mark_hold_ms, rare_mode, rare_period_ms}): number[]`
  — для каждого байта момент (ms, `performance.now()`), до которого он подсвечен; в режиме
  редких данных подсвечиваются только изменения с `stable_ms ≥ rare_period_ms`.
- Колонки: CH 36 · Флаги 70 · ID 92 · DLC 40 · Данные 8×26 · Период 82 · Счётчик 82 ·
  FC 48 (только при агрегаторе) · ASCII 84 · Комментарий (остаток).
- Действия (`actions.ts`, вид main): `clear` (Ctrl+N), `toggleStream` (F2),
  `bitmap` (F3), `frames` (Ctrl+F3), `comment` (F4), `copyToTx` (Ctrl+↓), `split`,
  `rareMode`, `rarePeriod`, `hexIds`, `sort`, `groupByChannel`, `saveRxList`
  (скачивание `.txt` со снимком таблицы), `addIdToFilter`.
- Контекстное меню строки — пункты спека §3.2 в порядке десктопа.

- [ ] **Step 1: Failing tests**: `order keeps arrival order, sorts by id, groups by channel`,
  `highlight holds for mark_hold_ms`, `rare mode ignores frequently changing bytes`,
  `F4 opens comment dialog for selected row and sends comment_set` (компонентный).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Проверить в браузере**: монитор с демо-данными, подсветка видна, контекстное
  меню целиком в экране, диалог комментария, колонки читаемы на 1366×650.
- [ ] **Step 6: Commit** `feat(frontend): receive monitor with highlighting, context menu, comments`.

### Task 15 (C2): Раздельный приём

**Files:** Create `frontend/src/features/monitor/SplitMonitor.tsx`; Modify `ReceiveArea.tsx`
- Interfaces: при `split` — по гриду на канал с заголовком «Канал N: <название>»
  (`rsSplitCaptionAlias`), общие действия работают для выделенной строки активного грида.
- [ ] Компонентный тест `split shows one grid per channel with rows filtered` → implement → PASS.
- [ ] **Проверить в браузере** (2 канала бок о бок на 1366 при открытой панели фильтров).
- [ ] **Commit** `feat(frontend): separate receive per channel`.

### Task 16 (C3): Битовая карта и агрегатор

**Files:** Create `frontend/src/features/monitor/{BitmapWindow.tsx,FramesWindow.tsx,bitHistory.ts}`; Test `frontend/tests/bitHistory.test.ts`
- Interfaces: `BitHistory.update(bytes: number[], now: number)`, `changedUntil(): number[][]`
  (на байт × бит, держится `mark_hold_ms`); окно битовой карты: заголовок
  «[CH] ID: Детали сообщения» (`rsMDCaptionChan`), сетка x80…x01 + «Dec byte», поле
  «Комментарий» (тот же `comment_set`), можно открыть несколько окон (по одному на ID);
  окно агрегатора «[CH] ID: Данные сообщения» — грид (Флаги, DLC, Данные, Период, Счётчик,
  ASCII, Комментарий) по `monitor_frames`, обновление раз в 1 с, «Строк: N».
- [ ] Тесты `bit change held for hold time`, `multiple windows keyed by message` → PASS.
- [ ] **Проверить в браузере** (окна не выходят за экран, читаемость нулей ≥ 4.5:1).
- [ ] **Commit** `feat(frontend): bit-map and unique-data windows`.

---

## Milestone D — Поток

### Task 17 (D1): Режим Поток, запись, метки, файлы

**Files:**
- Create: `frontend/src/features/stream/{StreamGrid.tsx,streamCache.ts,MarkerDialog.tsx,MarkersDialog.tsx,actions.ts}`,
  `frontend/src/features/files/FileDialog.tsx`
- Test: `frontend/tests/streamCache.test.ts`, `frontend/tests/fileDialog.test.tsx`

**Interfaces:**
- `streamCache.ts`: `StreamCache(pageSize = 200)` — `missingPages(first, last): number[]`,
  `put(start, rows)`, `get(i)`, `applyTail(start, rows)`, `reset()`.
- Колонки: Время 90 · Флаги 70 · CH 36 · Rx/Tx 48 · ID 92 · DLC 40 · Данные 8×26 · ASCII 84 · Комментарий.
- Действия: `record` (F5), `marker` (F8, диалог «Установить точку останова / метку»),
  `autoMarker` (F9, метка `#N` без диалога), `markers` (список «Точки останова / метки» с
  «Перейти к метке»), `loadStream`, `saveStream` (FileDialog: формат `.trc`/`.jsonl`),
  `toTracer` (Ctrl+F12).
- `FileDialog`: режимы `open | save`, `kind: "traces" | "lists"`, список файлов
  (имя, размер, дата), поле имени, «Загрузить с компьютера», «Скачать».
- [ ] Тесты `missingPages`, `tail keeps follow window`, `save dialog validates name` → PASS.
- [ ] **Проверить в браузере**: F2 переключает, F5 пишет, статусбар «Запись», прокрутка
  вверх останавливает автоследование, F8/F9, список меток, сохранение `.trc`.
- [ ] **Commit** `feat(frontend): stream view with recording, markers and trace files`.

---

## Milestone E — Передача

### Task 18 (E1): Док «CAN Передача»

**Files:**
- Create: `frontend/src/features/transmit/{txModel.ts,TransmitDock.tsx,TaskGrid.tsx,TaskEditor.tsx,TriggerRow.tsx,actions.ts}`
- Test: `frontend/tests/txModel.test.ts`, `frontend/tests/transmit.test.tsx`

**Interfaces:**
- `txModel.ts`: `TaskForm` (строковые поля редактора), `parseTaskForm(form, base: TxTaskJson): TxTaskJson`
  (бросает `FieldError{field, message}`), `taskToForm(t)`, `fillData(value: string, dlc: number): string[]`,
  `newTask(id: string): TxTaskJson` (канал 1, ID 000, DLC 8, нули, период 10).
- Колонки таблицы: ☐ (цикл) · CH · Флаги · ID · DLC · Данные · Период · Счётчик · Комментарий.
- Редактор правит выделенную задачу (изменение поля → `tx_upsert` после валидации);
  кнопки «Послать» (Enter), «Добавить», «Старт/Пауза», «Копировать», «Удалить»;
  строка триггера: Действие, Задержка, Триггер Ch («Все», 1, 2), ID, DLC, 8 полей.
- Контекстное меню — пункты спека §3.6; «Загрузить»/«Сохранить» через FileDialog (`lists`).
- `copyToTx` из монитора создаёт задачу из выделенной строки.
- [ ] Тесты: `parseTaskForm rejects bad id/dlc/period with field name`, `fillData`,
  `empty trigger byte means dont-care`, `Enter in editor sends tx_send` (компонентный).
- [ ] **Проверить в браузере**: док 270 px помещается на 1366×650, все поля видны,
  счётчики тикают, триггер срабатывает на демо-ответ `0x7E8`.
- [ ] **Commit** `feat(frontend): CAN transmit dock with tasks and triggers`.

---

## Milestone F — Фильтры

### Task 19 (F1): Панель фильтров

**Files:**
- Create: `frontend/src/features/filters/{FiltersPanel.tsx,HwFilterGrid.tsx,HwFilterDialog.tsx,RangeTree.tsx,RangeFilterDialog.tsx,RangeExclusionDialog.tsx,filtersModel.ts}`
- Test: `frontend/tests/filtersModel.test.ts`, `frontend/tests/filters.test.tsx`

**Interfaces:**
- `filtersModel.ts`: `describeRange(r)` → «Канал 1: С 100 по 1FF» (`rsRangeFilter`),
  `describeExclusion(ex, simple)` → «Исключить Id: 120 / Маска: 7F0» / «Исключить Id: 120»,
  `parseExcludeList(s: string): number[]` (через запятую, hex).
- Вкладки «Фильтр ID/Маска» (грид: ☐ · CH · Num · ID · Маска; двойной клик → диалог
  «Установить фильтр по маске»; тулбар: Открыть, Сохранить, Редактировать) и «Фильтр
  Диапазон» (дерево по каналам; тулбар: Добавить, Редактировать, Удалить; двойной клик).
  В простом режиме маска скрыта. Ctrl+F — показать/скрыть панель.
- [ ] Тесты `describe*`, `parseExcludeList rejects junk`, `checkbox toggles hw slot` → PASS.
- [ ] **Проверить в браузере**: панель 340 px, монитор при этом читаем на 1366.
- [ ] **Commit** `feat(frontend): filters panel (hardware slots, ranges, exclusions)`.

---

## Milestone G — Прибор и каналы

### Task 20 (G1): Подключение, скорости, информация

**Files:**
- Create: `frontend/src/features/device/{ConnectDialog.tsx,BitrateManager.tsx,DeviceInfoDialog.tsx,ChannelMenu.tsx}`
- Modify: `frontend/src/lib/timing.ts`
- Test: `frontend/tests/timing.test.ts` (дополнить), `frontend/tests/connect.test.tsx`

**Interfaces:**
- `timing.ts`: `bestTiming(bitrate: number, clockHz: number, samplePct: number, limits = {presc:[1,512], seg1:[1,256], seg2:[1,128], sjw:[1,128]}): Timing | null`;
  `timingInfo(t: Timing, clockHz: number): {bitrate: number, samplePct: number, accuracyPct: number}`.
- `ConnectDialog` («Настройки устройства»): мост хост:порт; вкладки «Канал 1: CAN»,
  «Канал 2: CAN» — Название канала, Номинальная скорость (пресеты carbus-lib 10k…1000k +
  свои из `bitrates.json`) и «…», Только слушать, Включить терминатор 120 Ом (если
  прибор умеет), Открывать после подключения; «Принять» → `connect`; «Отмена».
- `BitrateManager` («Управление скоростями»): список, Добавить/Удалить/▲/▼, Название,
  Скорость (Кбит/с), Точка выборки % (50–90), Prescaler/Seg1/Seg2/SJW с лимитами,
  «Фактическая скорость», «Фактическая точка выборки», «Точность».
- `ChannelMenu` (выпадающая кнопка тулбара): «Информация об устройстве», по каналам
  «Терминатор 120 Ом» (флажок, `channel_terminator`).
- [ ] Тесты `bestTiming 500k@120MHz,75% → actual 500k`, `timingInfo accuracy`,
  `connect dialog sends channel configs` → PASS.
- [ ] **Проверить в браузере**: диалоги целиком в 1366×650, подключение к демо.
- [ ] **Commit** `feat(frontend): device connect dialog, bitrate manager, device info`.

---

## Milestone H — Отладчик

### Task 21 (H1): Вид отладчика — просмотр и воспроизведение

**Files:**
- Create: `frontend/src/features/tracer/{TracerView.tsx,TracerGrid.tsx,IdTable.tsx,tracerStore.ts,actions.ts,DelayMenu.tsx,CustomDelayDialog.tsx}`
- Test: `frontend/tests/tracerStore.test.ts`, `frontend/tests/tracer.test.tsx`

**Interfaces:**
- Меню вида: «Трейс» (Новый, Открыть, Недавние, Сохранить, Сохранить как…), «Комментарий»
  (Открыть, Редактировать F4, Очистить); тулбар и строка опций — спек §3.9;
  `IdTable` справа (☐ · CH · ID · Кол-во; «Все»/«Нет»; контекстное меню);
  статусбар отладчика: прогресс, «Текущая строка: N / Выделено: M», «Строк: N из M»,
  «Передача в канал …», «Пауза: Авто | N мс».
- `tracerStore.ts`: кэш строк (как `StreamCache`), `selectionPayload(sel): number[] | null`.
- [ ] Тесты: `play sends selection when play-selected on`, `F9 toggles play/pause`,
  `step sends tracer_step` → PASS.
- [ ] **Проверить в браузере**: открыть сохранённый в D1 трейс, проиграть в «Окно Приём»,
  монитор оживает; таблица ID и грид помещаются на 1366×650.
- [ ] **Commit** `feat(frontend): tracer view with playback`.

### Task 22 (H2): Отладчик — правка, точки останова, копирование

**Files:**
- Create: `frontend/src/features/tracer/{RowEditorDialog.tsx,BreakpointsDialog.tsx,copyRows.ts}`
- Test: `frontend/tests/copyRows.test.ts`, `frontend/tests/rowEditor.test.tsx`

**Interfaces:**
- `copyRows(rows, cols, {header, idHex, dataHex}): string` (TSV для Excel);
  `RowEditorDialog` («Добавить строку» / «Отредактировать»): ID, 29 bit, DLC, данные (8),
  RTR, Задержка до/после (мс), Значение + Заполнить, Сохранить/Отмена;
  `BreakpointsDialog` — список с «Перейти»; хоткеи Ins, Ctrl+Ins, Ctrl+Enter, Ctrl+Del,
  Ctrl+C, F5, Ctrl+F5, Shift+F5.
- [ ] Тесты `copyRows honours hex/dec and header`, `row editor validates and emits row` → PASS.
- [ ] **Проверить в браузере**: правка строки, точка останова останавливает проигрывание.
- [ ] **Commit** `feat(frontend): tracer editing, breakpoints, copy rows`.

---

## Milestone I — Настройки и завершение

### Task 23 (I1): Настройки приложения и фоновое логирование

**Files:**
- Create: `frontend/src/features/settings/SettingsDialog.tsx`, `backend/app/logger.py`
- Modify: `backend/app/hub.py` (автозапуск лога при подключении), `frontend/src/core/store.ts`
- Test: `backend/tests/test_logger.py`, `frontend/tests/settings.test.tsx`

**Interfaces:**
- Вкладки: «Стиль интерфейса», «Шрифт в таблицах», «Приём данных», «Передача данных»,
  «Поток и трейсер», «Фильтр и шлюз», «Фоновое логирование» — поля по `DEFAULT_SETTINGS`;
  «Принять» → `settings_set`; тема/шрифт/цвет применяются сразу (CSS-переменные).
- `StreamLogger(traces_dir, settings, now)` — `start(meta)`, `write(f)`, `stop() -> Path`;
  пишет `logs/<маска>.trc` (заголовок с N и длительностью — при `stop`), `# Brand=…` и т.п.
- [ ] Тесты `logger writes trc with meta and tx when enabled`, `settings dialog applies theme` → PASS.
- [ ] **Проверить в браузере**: светлая и тёмная тема, крупный шрифт 16 не ломает колонки.
- [ ] **Commit** `feat: application settings dialog and background stream logging`.

### Task 24 (I2): Документация и финальная проверка

**Files:** Modify `README.md`, `docs/reference/carbus-dfm/UI_MAP.md` (раздел «Статус порта»)

- [ ] README: запуск, `./data` и `./traces`, хоткеи, что вне этапа 1, ручная проверка на шине.
- [ ] Полная UI-проверка всех видов и диалогов на 1366×768, 1366×650, 1920×1080 + аудит.
- [ ] Все тесты: `pytest -q`, `vitest run`, `tsc`, `vite build`, `docker compose build`.
- [ ] **Commit** `docs: desktop-parity stage 1 status, README`.
