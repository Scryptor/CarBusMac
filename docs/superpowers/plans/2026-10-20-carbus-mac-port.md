# CarBUS for Mac — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Веб-инструмент для программатора CAN-Hacker v3.2 на Mac: живой монитор, карта бит, поток, запись/просмотр трейсов, передача с триггерами, фильтры, битрейт — бэкенд в Docker, GUI в Chrome.

**Architecture:** Нативный штатный мост `carbus_async.tcp_bridge` на маке держит USB-порт. Python/FastAPI-бэкенд в Docker цепляется к мосту через `CarBusDevice.open_tcp("host.docker.internal", 7000)` (библиотека `carbus-lib`), агрегирует приём, пишет трейсы, шлёт передачу, отдаёт SPA и WebSocket. Chrome рисует данные. Вся логика бэкенда тестируется против `FakeSession`, поэтому железо нужно только одному адаптеру.

**Tech Stack:** Python 3.12, FastAPI, uvicorn[standard], pydantic, carbus-lib; фронт — Vite + TypeScript (без тяжёлых фреймворков), Vitest; Docker + docker-compose.

**Spec:** `docs/superpowers/specs/2026-10-20-carbus-mac-port-design.md` (и карта UI `docs/reference/carbus-dfm/UI_MAP.md`).

## Global Constraints

- Образ бэкенда — **Python 3.12**. `carbus-lib` требует ≥3.10, async (pyserial-asyncio).
- Зависимости бэкенда: `carbus-lib`, `fastapi`, `uvicorn[standard]`, `pydantic`. Фронт без тяжёлых фреймворков.
- **Публичный relay `carbus-lib` (`185.42.26.80`, пароль `1234`) не использовать никогда.** Только локальный `tcp_bridge`.
- Мост слушает локально; контейнер ходит через `host.docker.internal`; наружу (LAN/интернет) не публиковать.
- **Метки времени кадров — от прибора**; если прибор не дал — ставить arrival-время и помечать `ts_source`. Не выдумывать.
- Трейсы — файлы в примонтированной с хоста папке `./traces`.
- v1 — **классический CAN**. FD-поля в моделях сохраняем, FD-вкладку в UI не делаем.
- Целевой браузер — **Chrome**. `listen_only` — выбираемый режим, не принудительный дефолт.
- Проект: `~/dev/canH/carbus-mac`, git-репозиторий.

## Review Focus

- **Высокая загрузка шины:** монитор обязан слать дельты с фиксированной частотой и хранить *последнее* значение по ID без потери и без затопления UI. → BE-2 step «coalescing».
- **Мост недоступен/обрыв связи:** `connect`/поток падает → сервер отдаёт статус-ошибку и остаётся живым, допускает повторный connect. → BE-5 step «session failure».
- **29-бит против 11-бит ID:** форматирование (8 vs 3 hex) и фильтры (ext-индексы) должны различать. → FE-2 step «id format» + BE-5 filter mapping.
- **Метки времени трейса:** источник — прибор; при отсутствии — arrival с пометкой; значения сохраняются при round-trip. → BE-3 step «ts source».
- **Невалидный ввод по WS** (битый JSON / неизвестный тип / плохой hex данных): сервер отвечает `error`, соединение не рвётся. → BE-5 step «bad input».

---

## File Structure

```
carbus-mac/
  backend/
    pyproject.toml
    app/
      __init__.py
      models.py         # CanFrame + enums (чистые данные)
      can_session.py    # CanSession (Protocol) + FakeSession
      carbus_session.py # CarbusSession — адаптер к carbus-lib (единственное место с железом)
      monitor.py        # MonitorState — агрегация/коалесценция
      trace.py          # TraceWriter / TraceReader / TracePlayer
      transmit.py       # TransmitManager — shot / periodic / triggers
      schemas.py        # pydantic-модели WS/REST
      server.py         # FastAPI: REST + WS + отдача статики, DI сессии
    tests/              # pytest (+pytest-asyncio) против FakeSession
  frontend/
    package.json, vite.config.ts, tsconfig.json, index.html
    src/
      ws.ts             # клиент WS + типы сообщений (зеркало schemas.py)
      lib/              # ЧИСТЫЕ функции (тестируются Vitest): format.ts, bits.ts, frame.ts, timing.ts
      monitor.ts, bitmap.ts, stream.ts, transmit.ts, filters.ts, main.ts
    tests/              # Vitest для src/lib/*
  Dockerfile            # multistage: build frontend → run backend+static
  docker-compose.yml
  run-bridge.sh         # запуск carbus_async.tcp_bridge на маке через uv/pipx
  traces/               # смонтированная папка трейсов (в .gitignore, кроме .gitkeep)
  README.md
```

---

## Task 1: BE-1 — Данные и сессия (CanFrame, CanSession, FakeSession)

Фундамент: чистая модель кадра и абстракция устройства, чтобы вся остальная логика тестировалась без железа.

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/models.py`, `backend/app/can_session.py`
- Test: `backend/tests/test_can_session.py`

**Interfaces:**
- Produces:
  - `CanFrame` (dataclass, `backend/app/models.py`): `channel:int, can_id:int, data:bytes, extended:bool=False, rtr:bool=False, fd:bool=False, brs:bool=False, timestamp:float=0.0, ts_source:str="device"`.
  - `class CanSession(Protocol)` (async): `connect()->None`, `close()->None`, `get_device_info()->dict`, `open_channel(channel:int, bitrate:int, listen_only:bool)->None`, `send(frame:CanFrame)->None`, `set_hw_filter(channel:int, index:int, can_id:int, mask:int, extended:bool)->None`, `clear_filters(channel:int)->None`, `frames()->AsyncIterator[CanFrame]`.
  - `FakeSession` (impl of `CanSession`): `push(frame:CanFrame)` ставит кадр в `frames()`; `sent:list[CanFrame]` копит `send`; `info:dict` настраиваемый; `connect` может быть сконфигурирован бросать (`fail_connect:bool`).

- [ ] **Step 1: Failing test** — `test_fake_session_push_and_send`, `test_fake_session_connect_can_fail`:

```python
async def test_fake_session_push_and_send():
    s = FakeSession(info={"hardware_name": "HW_CH32"})
    await s.connect(); await s.open_channel(1, 500_000, listen_only=True)
    f = CanFrame(channel=1, can_id=0x123, data=b"\x01\x02")
    s.push(f)
    got = await anext(s.frames())
    assert got.can_id == 0x123 and got.data == b"\x01\x02"
    await s.send(CanFrame(channel=1, can_id=0x7E0, data=b"\x3e"))
    assert s.sent[-1].can_id == 0x7E0

async def test_fake_session_connect_can_fail():
    s = FakeSession(fail_connect=True)
    with pytest.raises(ConnectionError):
        await s.connect()
```

- [ ] **Step 2: Run, verify fail** — `pytest backend/tests/test_can_session.py -v` → FAIL (import/NameError).
- [ ] **Step 3: Implement** `CanFrame`, `CanSession` Protocol, `FakeSession` в указанных файлах; `pyproject.toml` с зависимостями из Global Constraints и dev-группой `pytest, pytest-asyncio, httpx`. `frames()` у FakeSession — async-очередь.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(backend): CanFrame, CanSession protocol, FakeSession`.

---

## Task 2: BE-2 — Монитор (агрегация, коалесценция, маска изменений, период)

**Files:**
- Create: `backend/app/monitor.py`
- Test: `backend/tests/test_monitor.py`

**Interfaces:**
- Consumes: `CanFrame` (BE-1).
- Produces:
  - `MonitorRow` (dataclass): `channel:int, can_id:int, extended:bool, dlc:int, data:bytes, count:int, period_ms:float|None, changed_mask:int, last_ts:float`. `changed_mask` — битовая маска *байтов*, изменившихся с прошлого снапшота (бит i = байт i изменился).
  - `class MonitorState`: `update(frame:CanFrame)->None`; `snapshot_delta()->list[MonitorRow]` — строки, изменившиеся/новые с прошлого вызова, значение = последнее; `clear()->None`. Ключ строки — `(channel, can_id, extended)`.

- [ ] **Step 1: Failing test** — покрыть last-value-wins, период, маску изменений, дельту:

```python
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
    m.snapshot_delta()                      # сбрасывает «изменения»
    m.update(CanFrame(1, 0x200, b"\xAA\xCC"))
    r = m.snapshot_delta()[0]
    assert r.changed_mask == 0b10           # изменился только байт 1

def test_snapshot_delta_returns_only_changed():
    m = MonitorState()
    m.update(CanFrame(1, 0x300, b"\x01"))
    assert len(m.snapshot_delta()) == 1
    assert m.snapshot_delta() == []         # без новых апдейтов — пусто
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `MonitorState`/`MonitorRow`. Коалесценция: `update` только копит состояние по ключу; частоту снапшотов задаёт вызывающий (BE-5 дёргает `snapshot_delta()` на фикс. частоте ~25 Гц). Период — EWMA или разница последних двух `timestamp`, мс.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(backend): MonitorState aggregation with change mask and period`.

---

## Task 3: BE-3 — Трейсы (запись, чтение, воспроизведение)

**Files:**
- Create: `backend/app/trace.py`
- Test: `backend/tests/test_trace.py`

**Interfaces:**
- Consumes: `CanFrame` (BE-1).
- Produces:
  - Формат — JSON Lines, по кадру: `{"ts":float,"ts_source":str,"ch":int,"id":int,"ext":bool,"dlc":int,"data":str(hex),"dir":"rx"|"tx"}`.
  - `class TraceWriter(path:str)`: `write(frame:CanFrame, direction:str="rx")->None`, `close()->None`.
  - `class TraceReader(path:str)`: `frames()->list[CanFrame]`.
  - `class TracePlayer(frames:list[CanFrame])`: `async play(send:Callable[[CanFrame],Awaitable], speed:float=1.0, to_monitor:bool=False, repeat:bool=False, sleep=asyncio.sleep)->None`; `step()`. Межкадровая пауза — из разницы `timestamp`, делённой на `speed`; `to_monitor=True` не вызывает `send` (только отдаёт в монитор — см. BE-5).

- [ ] **Step 1: Failing test** — round-trip сохраняет поля и `ts_source`; player выдерживает интервалы на инъектируемом `sleep`:

```python
def test_trace_roundtrip_preserves_ts_source(tmp_path):
    p = str(tmp_path / "t.jsonl")
    w = TraceWriter(p)
    w.write(CanFrame(1, 0x1A, b"\xde\xad", timestamp=5.0, ts_source="device"))
    w.write(CanFrame(2, 0x2B, b"\xff", timestamp=5.25, ts_source="arrival"), direction="tx")
    w.close()
    fr = TraceReader(p).frames()
    assert [f.can_id for f in fr] == [0x1A, 0x2B]
    assert fr[0].data == b"\xde\xad" and fr[0].ts_source == "device"

async def test_player_respects_interframe_delay():
    slept = []
    async def fake_sleep(d): slept.append(d)
    sent = []
    frames = [CanFrame(1, 1, b"", timestamp=0.0), CanFrame(1, 2, b"", timestamp=0.2)]
    await TracePlayer(frames).play(send=lambda f: sent.append(f) or _done(),
                                   speed=2.0, sleep=fake_sleep)
    assert abs(slept[0] - 0.1) < 1e-6   # 0.2s / speed 2.0
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** writer/reader/player. (`_done()` в тесте — хелпер, возвращающий завершённый awaitable; реальный `send` — корутина.)
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(backend): JSONL trace writer/reader/player`.

---

## Task 4: BE-4 — Передача (shot, периодика, триггеры)

**Files:**
- Create: `backend/app/transmit.py`
- Test: `backend/tests/test_transmit.py`

**Interfaces:**
- Consumes: `CanSession`, `CanFrame` (BE-1).
- Produces:
  - `TxTask` (dataclass): `id:str, frame:CanFrame, period_ms:int|None`. `period_ms=None` → одиночный.
  - `Trigger` (dataclass): `match_channel:int, match_id:int, match_data:bytes, match_mask:bytes, action:CanFrame`.
  - `class TransmitManager(session:CanSession, clock=time.monotonic, sleep=asyncio.sleep)`:
    - `async shot(frame:CanFrame)->None` → `session.send`.
    - `add_task(task:TxTask)->str`, `async run(task_id:str)->None` (стартует периодику), `stop(task_id:str)->None`, `async run_all()`, `stop_all()`.
    - `add_trigger(t:Trigger)->str`, `remove_trigger(id:str)`, `async on_frame(frame:CanFrame)->None` — если кадр совпал по `(channel,id, data&mask)`, шлёт `action`.

- [ ] **Step 1: Failing test** — shot шлёт; периодика шлёт N раз за интервалы (инъект. sleep/clock); триггер срабатывает по маске, не срабатывает иначе:

```python
async def test_shot_sends_once():
    s = FakeSession(); await s.connect()
    await TransmitManager(s).shot(CanFrame(1, 0x7E0, b"\x02\x3e\x00"))
    assert len(s.sent) == 1 and s.sent[0].can_id == 0x7E0

async def test_trigger_fires_on_masked_match():
    s = FakeSession(); await s.connect()
    tm = TransmitManager(s)
    tm.add_trigger(Trigger(1, 0x123, b"\x10", b"\xf0", CanFrame(1, 0x321, b"\x01")))
    await tm.on_frame(CanFrame(1, 0x123, b"\x1A"))   # 0x1A & 0xF0 == 0x10 → match
    await tm.on_frame(CanFrame(1, 0x123, b"\x2A"))   # 0x2A & 0xF0 == 0x20 → no
    assert [f.can_id for f in s.sent] == [0x321]
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `TransmitManager`. Периодика — `asyncio.Task` на задачу, цикл `send`→`await sleep(period_ms/1000)`; `stop` отменяет. Может опираться на `carbus-lib` `PeriodicCanSender` в `CarbusSession`, но менеджер работает через `CanSession.send`, чтобы тестироваться на FakeSession.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(backend): transmit manager (shot, periodic, triggers)`.

---

## Task 5: BE-5 — Схемы + сервер (REST + WebSocket + статика + DI)

Связывает всё: WS отдаёт дельты монитора и поток, принимает команды; REST — connect/канал/фильтры/передача/запись/трейсер/список трейсов.

**Files:**
- Create: `backend/app/schemas.py`, `backend/app/server.py`
- Test: `backend/tests/test_server.py`

**Interfaces:**
- Consumes: BE-1..BE-4.
- Produces (pydantic, `schemas.py`) — зеркалит `frontend/src/ws.ts`:
  - C→S команды (`type` + поля): `connect{bridge_host,bridge_port}`, `disconnect`, `open_channel{channel,bitrate,listen_only}`, `set_hw_filter{channel,index,can_id,mask,extended}`, `clear_filters{channel}`, `tx_shot{frame}`, `tx_add{task}`, `tx_run{id}`, `tx_stop{id}`, `tx_run_all`, `tx_stop_all`, `trigger_add{trigger}`, `record_start{name}`, `record_stop`, `tracer_load{name}`, `tracer_play{speed,repeat,to_monitor,only_channel}`, `tracer_stop`, `tracer_step`, `clear`.
  - S→C события: `device_info{info}`, `monitor_delta{rows}`, `stream{frames}`, `status{connected:bool,bus:bool,message:str}`, `error{message}`.
  - `frame`/`task`/`trigger`/`row` — вложенные модели (поля как в BE-1/BE-2/BE-4; `data` как hex-строка).
  - `create_app(session_factory:Callable[[],CanSession]) -> FastAPI`: WS `/ws`, статика на `/`, REST `GET /api/traces` (список файлов в `./traces`). Монитор-петля дергает `snapshot_delta()` ~25 Гц и шлёт `monitor_delta` только при непустой дельте.

- [ ] **Step 1: Failing tests** — через `TestClient` с подменой `session_factory` на `FakeSession`:

```python
def test_connect_then_device_info():
    app = create_app(lambda: FakeSession(info={"hardware_name":"HW_CH32"}))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type":"connect","bridge_host":"h","bridge_port":7000})
        assert _wait(ws, "device_info")["info"]["hardware_name"] == "HW_CH32"

def test_bad_input_keeps_socket_alive():   # Review Focus: невалидный ввод
    app = create_app(lambda: FakeSession())
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_text("{not json")
        assert _wait(ws, "error")
        ws.send_json({"type":"nonsense"})
        assert _wait(ws, "error")
        ws.send_json({"type":"connect","bridge_host":"h","bridge_port":7000})
        assert _wait(ws, "device_info")        # сокет жив

def test_session_connect_failure_reports_status():  # Review Focus: мост недоступен
    app = create_app(lambda: FakeSession(fail_connect=True))
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.send_json({"type":"connect","bridge_host":"h","bridge_port":7000})
        st = _wait(ws, "status"); assert st["connected"] is False and st["message"]

def test_tx_shot_reaches_session():
    captured = FakeSession()
    with TestClient(create_app(lambda: captured)).websocket_connect("/ws") as ws:
        ws.send_json({"type":"connect","bridge_host":"h","bridge_port":7000})
        _wait(ws, "device_info")
        ws.send_json({"type":"tx_shot","frame":{"channel":1,"can_id":2016,"data":"023e00","extended":False}})
        _wait(ws, "status")
        assert captured.sent and captured.sent[-1].can_id == 2016
```

(`_wait(ws,type)` — хелпер в тесте: читает JSON-сообщения, пока не встретит нужный `type`.)

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `schemas.py` и `create_app`. Разбор команд обёрнут в try/except → `error`-событие, сокет не рвётся. На `connect` создаётся сессия через фабрику; ошибка → `status{connected:false}`. Задача-петля шлёт `monitor_delta`; принятые кадры идут в `MonitorState`, активный `TraceWriter`, `TransmitManager.on_frame`. Фильтры: UI даёт `channel`, бэкенд маппит в индексы `carbus-lib` (`set_std_id_filter` 0–27 / `set_ext_id_filter` 28–35) — зафиксировать функцию маппинга здесь.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(backend): FastAPI server with WS protocol and REST`.

---

## Task 6: BE-6 — Адаптер carbus-lib (CarbusSession) + smoke на железе

Единственное место, где настоящий `carbus-lib`. Юнит-логика уже покрыта на FakeSession; здесь — честный адаптер и опциональный интеграционный тест.

**Files:**
- Create: `backend/app/carbus_session.py`
- Test: `backend/tests/test_carbus_session_smoke.py` (skip без `CARBUS_BRIDGE`)

**Interfaces:**
- Consumes: `CanSession` (BE-1), `carbus_async.CarBusDevice/CanMessage` (внешняя).
- Produces: `class CarbusSession(host:str, port:int)` реализует `CanSession`:
  - `connect` → `CarBusDevice.open_tcp(host, port)`; `get_device_info` → маппинг `DeviceInfo` (`hardware_name, firmware_version, serial_int, channel_types, channel_features, features`) в dict; `open_channel` → `open_can_channel(channel, nominal_bitrate=bitrate, listen_only=...)`; `send` → `send_can(CanMessage(...), channel)`; `frames()` → обёртка над `receive_can()` c `CanFrame` (timestamp прибора → `ts_source="device"`, иначе arrival); фильтры → `set_std_id_filter`/`set_ext_id_filter`/`clear_all_filters`.

- [ ] **Step 1: Failing test** — gated smoke:

```python
@pytest.mark.skipif(not os.environ.get("CARBUS_BRIDGE"), reason="no bridge")
async def test_real_device_info():
    host, port = os.environ["CARBUS_BRIDGE"].split(":")
    s = CarbusSession(host, int(port)); await s.connect()
    info = await s.get_device_info(); await s.close()
    assert info["hardware_name"]           # напр. HW_CH32
```

- [ ] **Step 2: Run, verify skip/fail** — без `CARBUS_BRIDGE` тест skip; это ок.
- [ ] **Step 3: Implement** `CarbusSession` по реальному API `carbus-lib` (см. `backend/app/carbus_session.py`; сигнатуры подтверждены в спайке).
- [ ] **Step 4: Manual verification on hardware** — на маке: `python -m carbus_async.tcp_bridge --serial /dev/cu.usbmodem… --port 7000`, затем `CARBUS_BRIDGE=127.0.0.1:7000 pytest backend/tests/test_carbus_session_smoke.py -v` → PASS с `hardware_name`.
- [ ] **Step 5: Commit** — `feat(backend): carbus-lib adapter (CarbusSession)`.

---

## Task 7: FE-1 — Каркас фронта + WS-клиент + полоса подключения и device info

**Files:**
- Create: `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/ws.ts`, `src/lib/format.ts`
- Test: `frontend/tests/format.test.ts`, `frontend/tests/ws.test.ts`

**Interfaces:**
- Produces:
  - `src/ws.ts`: типы сообщений (зеркало `schemas.py`), `class WsClient(url)`: `send(cmd)`, `on(type, handler)`, `connect()`. Парсинг входящих — через чистую `parseEvent(raw:string):Event`.
  - `src/lib/format.ts`: `formatId(id:number, extended:boolean):string` (ext → 8 hex `0x00000000`, std → 3 hex `0x000`); `formatData(bytes:number[]):string` (через пробел, 2 hex).

- [ ] **Step 1: Failing test** (Vitest):

```ts
test("formatId distinguishes 11 vs 29 bit", () => {
  expect(formatId(0x123, false)).toBe("0x123");
  expect(formatId(0x123, true)).toBe("0x00000123");
});
test("parseEvent rejects malformed json", () => {
  expect(() => parseEvent("{bad")).toThrow();
});
```

- [ ] **Step 2: Run, verify fail** — `npm --prefix frontend test`.
- [ ] **Step 3: Implement** каркас Vite+TS, `WsClient`, `parseEvent`, `format.ts`; `index.html` с полосой Connect (хост/порт моста, Connect/Disconnect), панель device info, подписка на `status`/`device_info`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): scaffold, WS client, connect bar, device info`.

---

## Task 8: FE-2 — Монитор-таблица + окно карты бит

**Files:**
- Create: `frontend/src/monitor.ts`, `frontend/src/bitmap.ts`, `frontend/src/lib/bits.ts`
- Modify: `frontend/src/main.ts`, `frontend/index.html`
- Test: `frontend/tests/bits.test.ts`

**Interfaces:**
- Consumes: `monitor_delta{rows}` (BE-5), `formatId`/`formatData` (FE-1).
- Produces:
  - `src/lib/bits.ts`: `changedByteIndices(mask:number):number[]`; `byteToBits(b:number):boolean[]` (8 бит, MSB→LSB, веса x80..x01); `diffBits(prev:number, cur:number):number[]` (индексы изменившихся бит).
  - `src/monitor.ts`: применяет дельты в таблицу по ключу `(ch,id,ext)`, обновление значений на месте, подсветка байт по `changed_mask`, колонки `CH|ID|DLC|Data|Count|Period|Δ`; тумблер Group by channel.
  - `src/bitmap.ts`: для выбранного ID — матрица байт×8бит с колонками `x80..x01` + десятичное значение + поле комментария; подсветка меняющихся бит.

- [ ] **Step 1: Failing test:**

```ts
test("byteToBits weights MSB first", () => {
  expect(byteToBits(0x81)).toEqual([true,false,false,false,false,false,false,true]);
});
test("changedByteIndices from mask", () => {
  expect(changedByteIndices(0b101)).toEqual([0,2]);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `bits.ts`, таблицу монитора и окно карты бит (ПКМ по строке / кнопка «bit-map» открывает его для ID).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Manual check** — в Chrome против бэкенда с `FakeSession`-фикстурой (эндпоинт/скрипт, пушащий синтетические кадры): значения меняются на месте, изменившиеся байты/биты подсвечиваются.
- [ ] **Step 6: Commit** — `feat(frontend): live monitor table and bit-map view`.

---

## Task 9: FE-3 — Поток + фильтры + битрейт

**Files:**
- Create: `frontend/src/stream.ts`, `frontend/src/filters.ts`, `frontend/src/lib/timing.ts`
- Modify: `frontend/src/main.ts`, `frontend/index.html`
- Test: `frontend/tests/timing.test.ts`

**Interfaces:**
- Consumes: `stream{frames}` (BE-5), команды `set_hw_filter`/`clear_filters`/`open_channel`.
- Produces:
  - `src/stream.ts`: хронологический лог, пауза, фильтр по ID (чистая `matchIdFilter(id, spec)`).
  - `src/filters.ts`: UI аппаратного фильтра (29-bit, маска+код, канал, Set, Clear) и Range (From/To/Exclude).
  - `src/lib/timing.ts`: `sampleToTiming(bitrate:number, clockHz:number, samplePct:number):{prescaler,seg1,seg2,sjw}` для ручного битрейта; валидатор диапазонов. Пресеты — список из спека (10k..1M).

- [ ] **Step 1: Failing test:**

```ts
test("timing sample point within 50-90 rejects out of range", () => {
  expect(() => sampleToTiming(500_000, 120_000_000, 95)).toThrow();
});
test("preset 500k produces integer prescaler", () => {
  const t = sampleToTiming(500_000, 120_000_000, 80);
  expect(Number.isInteger(t.prescaler)).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** поток, фильтры, битрейт (пресеты + ручной тайминг).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): stream view, filters, bitrate editor`.

---

## Task 10: FE-4 — Передача (задачи, редактор данных, триггеры)

**Files:**
- Create: `frontend/src/transmit.ts`, `frontend/src/lib/frame.ts`
- Modify: `frontend/src/main.ts`, `frontend/index.html`
- Test: `frontend/tests/frame.test.ts`

**Interfaces:**
- Consumes: команды `tx_*`, `trigger_add` (BE-5).
- Produces:
  - `src/lib/frame.ts`: `parseHexBytes(s:string):number[]` (валидирует, 0..8/.. длины), `parseCanId(s:string, extended:boolean):number` (проверка 11/29-бит диапазона), `encodeTxFrame(form):FrameMsg`.
  - `src/transmit.ts`: список задач; на задачу — ID, 29-bit/RTR, редактор данных (8/64 поля-байта), период; кнопки Shot/Run/Stop/Run All/Stop All; сохранение/загрузка списка (JSON); панель триггера (match ID/DLC/Data + action).

- [ ] **Step 1: Failing test:**

```ts
test("parseCanId enforces 11-bit range", () => {
  expect(parseCanId("7FF", false)).toBe(0x7ff);
  expect(() => parseCanId("800", false)).toThrow();   // >0x7FF для 11-бит
});
test("parseHexBytes validates", () => {
  expect(parseHexBytes("02 3e 00")).toEqual([2,62,0]);
  expect(() => parseHexBytes("zz")).toThrow();
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `frame.ts` и UI передачи с триггерами.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Manual check** — против бэкенда с `FakeSession`: Shot/Run видны в `sent`; триггер по синтетическому rx шлёт action.
- [ ] **Step 6: Commit** — `feat(frontend): transmit tasks, data editor, triggers`.

---

## Task 11: FE-5 — Запись и воспроизведение трейсов (UI)

**Files:**
- Create: `frontend/src/tracer.ts`
- Modify: `frontend/src/main.ts`, `frontend/index.html`
- Test: `frontend/tests/tracer.test.ts`

**Interfaces:**
- Consumes: REST `GET /api/traces` (список файлов), команды `record_start{name}`/`record_stop` и `tracer_load`/`tracer_play`/`tracer_stop`/`tracer_step` (BE-5); события `stream`/`monitor_delta` (для `to_monitor`).
- Produces:
  - `src/tracer.ts`: индикатор записи (Record/Pause — кнопка монитора шлёт `record_start`/`record_stop`); список трейс-файлов; окно Tracer: `Play/Stop/Step/Repeat`, `Only for Channel` (combo), `To Monitor` (checkbox), поле задержки/скорости. Чистая `playerControls(state, action):state` для кнопочной логики (play↔stop, step разрешён только в stop).

- [ ] **Step 1: Failing test:**

```ts
test("step allowed only when stopped", () => {
  expect(playerControls({playing:true}, "step")).toEqual({playing:true});   // игнор
  expect(playerControls({playing:false}, "step").stepped).toBe(true);
});
test("play then stop toggles", () => {
  expect(playerControls({playing:false}, "play").playing).toBe(true);
  expect(playerControls({playing:true}, "stop").playing).toBe(false);
});
```

- [ ] **Step 2: Run, verify fail** — `npm --prefix frontend test`.
- [ ] **Step 3: Implement** `tracer.ts`, кнопку Record в тулбаре монитора и окно Tracer; список файлов тянуть из `GET /api/traces`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Manual check** — против бэкенда с FakeSession: запись создаёт файл в `./traces`; загрузка и Play с `To Monitor` прогоняют кадры в монитор без `send` (в `sent` пусто).
- [ ] **Step 6: Commit** — `feat(frontend): trace record controls and tracer playback`.

---

## Task 12: PK-1 — Упаковка (Dockerfile, compose, мост, README)

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `run-bridge.sh`, `README.md`, `traces/.gitkeep`, `.gitignore`, `.dockerignore`

**Interfaces:**
- Consumes: собранный фронт (`frontend/dist`) и бэкенд (`backend/`).

- [ ] **Step 1: Напиши** multistage `Dockerfile` (stage 1 `node` билдит `frontend`; stage 2 `python:3.12-slim` ставит `backend` и копирует `dist` в статику; запуск `uvicorn app.server:app`). `docker-compose.yml`: сервис `backend`, порт `127.0.0.1:8000:8000`, `extra_hosts: ["host.docker.internal:host-gateway"]`, монтирование `./traces:/app/traces`, env `CARBUS_BRIDGE=host.docker.internal:7000`. `run-bridge.sh`: запуск `tcp_bridge` на маке через `uvx`/`pipx run` с авто-подбором `/dev/cu.usbmodem*`, bind локально.
- [ ] **Step 2: Verify compose** — `docker compose config` без ошибок; `docker compose build` успешно.
- [ ] **Step 3: README** — двухшаговый запуск: (1) `./run-bridge.sh` на маке, (2) `docker compose up`, открыть `http://localhost:8000` в Chrome; раздел про ограничение USB-в-Docker и про то, что relay не используется.
- [ ] **Step 4: Manual end-to-end** — мост на маке с реальным прибором → `docker compose up` → в Chrome виден `device_info`, монитор live (если прибор на шине).
- [ ] **Step 5: Commit** — `feat: docker packaging, bridge launcher, README`.

---

## Notes for executor

- Начать с `superpowers:using-git-worktrees` при изоляции и инициализировать репо в `~/dev/canH/carbus-mac`.
- Порядок: BE-1 → BE-2/3/4 (независимы между собой, зависят от BE-1) → BE-5 → BE-6 → FE-1 → FE-2/3/4/5 → PK-1.
- FastAPI-тесты — `httpx`/`TestClient`; async-логика — `pytest-asyncio`. Фронт-тесты — только на `src/lib/*` (чистые функции); UI проверяется вручную против FakeSession.
