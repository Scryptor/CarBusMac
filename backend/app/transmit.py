"""Передача (окно «CAN Передача» десктопа): список задач с периодом, счётчиком и
комментарием; однократная отправка, циклическая передача (Старт/Пауза), «Запустить
все»/«Остановить все», сброс счётчиков. У каждой задачи свой триггер: при приёме
кадра с заданными каналом/ID/DLC/данными (пустое поле данных — любое значение) через
«Задержку» выполняется действие над этой задачей: Одиночный, Старт или Стоп.

Отправка идёт через переданный `send` (хаб пишет кадр в шину и в поток как Tx),
`sleep` и `clock` инъектируются для детерминизма тестов. Период выдерживается по
расписанию (следующая отправка = прошлая + период), а не «от конца отправки», поэтому
частота не проседает на время самой отправки."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.models import CanFrame

ACTIONS = ("none", "single", "start", "stop")


@dataclass
class TriggerSpec:
    action: str = "none"
    delay_ms: int = 0
    channel: int = 0                  # 0 — любой канал («Все»)
    can_id: int | None = None
    ext: bool = False
    dlc: int | None = None            # None — любой DLC
    data: list[int | None] = field(default_factory=lambda: [None] * 8)


@dataclass
class TxTask:
    id: str
    channel: int = 1
    can_id: int = 0
    ext: bool = False
    rtr: bool = False
    data: bytes = b""
    period_ms: int = 10
    comment: str = ""
    running: bool = False
    count: int = 0
    trigger: TriggerSpec = field(default_factory=TriggerSpec)


def _id_ok(can_id: int, ext: bool) -> bool:
    return 0 <= can_id <= (0x1FFFFFFF if ext else 0x7FF)


def _int(d: dict, key: str, default: int, lo: int, hi: int) -> int:
    v = int(d.get(key, default))
    if not lo <= v <= hi:
        raise ValueError(f"{key}: {v} вне диапазона {lo}..{hi}")
    return v


def task_to_dict(t: TxTask) -> dict[str, Any]:
    tr = t.trigger
    return {
        "id": t.id, "channel": t.channel, "can_id": t.can_id, "ext": t.ext, "rtr": t.rtr,
        "data": t.data.hex(), "period_ms": t.period_ms, "comment": t.comment,
        "running": t.running, "count": t.count,
        "trigger": {"action": tr.action, "delay_ms": tr.delay_ms, "channel": tr.channel,
                    "can_id": tr.can_id, "ext": tr.ext, "dlc": tr.dlc, "data": list(tr.data)},
    }


def task_from_dict(d: dict[str, Any]) -> TxTask:
    """Строгая сборка задачи из JSON (UI/файл). Бросает ValueError с понятным текстом."""
    tid = str(d.get("id") or "")
    if not tid:
        raise ValueError("у задачи нет id")
    ext = bool(d.get("ext", False))
    can_id = int(d.get("can_id", 0))
    if not _id_ok(can_id, ext):
        raise ValueError(f"ID {can_id:X} вне диапазона {'29' if ext else '11'} бит")
    data = bytes.fromhex(str(d.get("data", "")))
    if len(data) > 8:
        raise ValueError("не более 8 байт данных")
    rtr = bool(d.get("rtr", False))
    if rtr:                                   # у RTR данных нет, а DLC есть: храним DLC нулевых байт
        data = bytes(len(data))
    t = d.get("trigger") or {}
    action = str(t.get("action", "none"))
    if action not in ACTIONS:
        raise ValueError(f"неизвестное действие триггера: {action}")
    t_ext = bool(t.get("ext", False))
    t_id = t.get("can_id")
    if t_id is not None:
        t_id = int(t_id)
        if not _id_ok(t_id, t_ext):
            raise ValueError("ID триггера вне диапазона")
    t_dlc = t.get("dlc")
    if t_dlc is not None:
        t_dlc = int(t_dlc)
        if not 0 <= t_dlc <= 8:
            raise ValueError("DLC триггера вне 0..8")
    t_data: list[int | None] = []
    for b in list(t.get("data") or [])[:8]:
        if b is None:
            t_data.append(None)
        else:
            b = int(b)
            if not 0 <= b <= 0xFF:
                raise ValueError("байт триггера вне 00..FF")
            t_data.append(b)
    t_data += [None] * (8 - len(t_data))
    if t_dlc is not None:                     # байт за DLC в кадре нет — условие на них не выполнится
        t_data = [b if i < t_dlc else None for i, b in enumerate(t_data)]
    return TxTask(
        id=tid,
        channel=_int(d, "channel", 1, 1, 4),
        can_id=can_id,
        ext=ext,
        rtr=rtr,
        data=data,
        period_ms=_int(d, "period_ms", 10, 1, 10000),
        comment=str(d.get("comment", "")),
        running=False,
        count=max(0, int(d.get("count", 0))),
        trigger=TriggerSpec(
            action=action,
            delay_ms=_int(t, "delay_ms", 0, 0, 10000),
            channel=_int(t, "channel", 0, 0, 4),
            can_id=t_id,
            ext=t_ext,
            dlc=t_dlc,
            data=t_data,
        ),
    )


def task_label(t: TxTask) -> str:
    """Задача в сообщениях — её ID в HEX, как в таблице передачи."""
    return f"{t.can_id:0{8 if t.ext else 3}X}"


def skipped_text(skipped: list[tuple[TxTask, str]], limit: int = 10) -> str:
    """«Запустить все»: какие задачи не запущены и почему — по списку на причину."""
    by_reason: dict[str, list[str]] = {}
    for t, why in skipped:
        by_reason.setdefault(why, []).append(task_label(t))
    parts = []
    for why, names in by_reason.items():
        more = f" и ещё {len(names) - limit}" if len(names) > limit else ""
        parts.append(f"{', '.join(names[:limit])}{more} ({why})")
    return "Не запущены задачи: " + "; ".join(parts)


class TransmitManager:
    def __init__(
        self,
        send: Callable[[CanFrame], Awaitable[None]],
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_change: Callable[[], None] = lambda: None,
        on_error: Callable[[str], None] = lambda message: None,
        clock: Callable[[], float] = time.monotonic,
        check: Callable[[int], None] | None = None,
        on_trigger_error: Callable[[str], None] | None = None,
    ) -> None:
        self._send = send
        self._sleep = sleep
        self._clock = clock
        # может ли канал передавать (бросает с объяснением): триггер на задаче закрытого
        # канала не должен на каждом кадре запускать и тут же ронять цикл
        self._check = check
        self._on_trigger_error = on_trigger_error or on_error
        self._trigger_failed: set[str] = set()   # задачи, о сбое триггера которых уже сказали
        self._on_change = on_change
        self._on_error = on_error
        self.tasks: list[TxTask] = []
        self._loops: dict[str, asyncio.Task] = {}
        self._pending: set[asyncio.Task] = set()

    # --- список задач ---
    def _index(self, task_id: str) -> int:
        for i, t in enumerate(self.tasks):
            if t.id == task_id:
                return i
        raise ValueError(f"нет задачи {task_id}")

    def _get(self, task_id: str) -> TxTask:
        return self.tasks[self._index(task_id)]

    def upsert(self, task: TxTask) -> None:
        """Добавить или заменить задачу. Состояние цикла и счётчик сохраняются:
        запущенная задача продолжает слать уже новый кадр."""
        try:
            i = self._index(task.id)
        except ValueError:
            task.running = False
            self.tasks.append(task)
        else:
            old = self.tasks[i]
            task.running, task.count = old.running, old.count
            self.tasks[i] = task
        self._on_change()

    def delete(self, task_id: str) -> None:
        self._stop_loop(task_id)
        self.tasks.pop(self._index(task_id))
        self._on_change()

    def clear(self) -> None:
        self.cancel_pending()
        for t in self.tasks:
            self._stop_loop(t.id)
        self.tasks = []
        self._on_change()

    def to_list(self) -> list[dict[str, Any]]:
        return [task_to_dict(t) for t in self.tasks]

    def load_list(self, items: list[dict[str, Any]]) -> None:
        tasks = [task_from_dict(d) for d in items]
        self.cancel_pending()
        for t in self.tasks:
            self._stop_loop(t.id)
        self.tasks = tasks
        self._on_change()                 # одно уведомление: без промежуточного пустого списка

    # --- отправка ---
    @staticmethod
    def _frame(t: TxTask) -> CanFrame:
        return CanFrame(channel=t.channel, can_id=t.can_id, data=t.data, extended=t.ext,
                        rtr=t.rtr, direction="tx")

    async def shot(self, frame: CanFrame) -> None:
        await self._send(frame)

    async def send_once(self, task_id: str) -> None:
        t = self._get(task_id)
        await self._send(self._frame(t))
        t.count += 1

    def start(self, task_id: str) -> None:
        t = self._get(task_id)
        loop = self._loops.get(task_id)
        if loop is not None and not loop.done():
            return
        t.running = True
        self._loops[task_id] = asyncio.create_task(self._loop(task_id))
        self._on_change()

    def _stop_loop(self, task_id: str) -> None:
        loop = self._loops.pop(task_id, None)
        if loop is not None:
            loop.cancel()

    def pause(self, task_id: str) -> None:
        t = self._get(task_id)
        if not t.running and task_id not in self._loops:
            return                        # уже стоит (триггер «Стоп» на частом кадре — не писать диск)
        self._stop_loop(task_id)
        t.running = False
        self._on_change()

    def start_all(self) -> None:
        for t in list(self.tasks):
            self.start(t.id)

    def pause_all(self) -> None:
        self.cancel_pending()
        changed = False
        for t in self.tasks:
            if t.running or t.id in self._loops:
                self._stop_loop(t.id)
                t.running = False
                changed = True
        if changed:
            self._on_change()

    def cancel_pending(self) -> None:
        """Отложенные срабатывания триггеров (задержка) — отменить."""
        for job in list(self._pending):
            job.cancel()

    def reset(self, task_id: str | None) -> None:
        for t in self.tasks:
            if task_id is None or t.id == task_id:
                t.count = 0
        self._on_change()

    async def _loop(self, task_id: str) -> None:
        due = self._clock()
        try:
            while True:
                t = self._get(task_id)          # каждый раз — актуальное определение
                await self._send(self._frame(t))
                t.count += 1
                period = t.period_ms / 1000.0
                due += period
                now = self._clock()
                if due < now - max(0.5, period):   # стоял цикл событий — не догонять пачкой
                    due = now
                await self._sleep(max(0.0, due - now))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # задача удалена или отправка упала — цикл гаснет, UI видит running=False;
            # упавшую отправку ещё и объясняем
            still_there = False
            for t in self.tasks:
                if t.id == task_id:
                    t.running = False
                    still_there = True
            self._loops.pop(task_id, None)
            self._on_change()
            if still_there:
                self._on_error(str(e) or e.__class__.__name__)

    # --- триггеры ---
    @staticmethod
    def _matches(tr: TriggerSpec, f: CanFrame) -> bool:
        if tr.action == "none" or tr.can_id is None:
            return False
        if tr.channel not in (0, f.channel) or tr.can_id != f.can_id or tr.ext != f.extended:
            return False
        if tr.dlc is not None and tr.dlc != len(f.data):
            return False
        for i, b in enumerate(tr.data):
            if b is not None and (i >= len(f.data) or f.data[i] != b):
                return False
        return True

    async def on_frame(self, f: CanFrame) -> None:
        if f.direction == "tx":
            return
        for t in list(self.tasks):
            if self._matches(t.trigger, f):
                job = asyncio.create_task(self._fire(t.id, t.trigger.action, t.trigger.delay_ms))
                self._pending.add(job)
                job.add_done_callback(self._pending.discard)

    async def _fire(self, task_id: str, action: str, delay_ms: int) -> None:
        try:
            if delay_ms:
                await self._sleep(delay_ms / 1000.0)
            task = next((t for t in self.tasks if t.id == task_id), None)
            if task is None:
                return
            if action in ("single", "start") and self._check is not None:
                self._check(task.channel)
            if action == "single":
                await self.send_once(task_id)
            elif action == "start":
                self.start(task_id)
            elif action == "stop":
                self.pause(task_id)
            self._trigger_failed.discard(task_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # сказать, а не молчать — но один раз, а не на каждом кадре частого сообщения
            if task_id not in self._trigger_failed:
                self._trigger_failed.add(task_id)
                self._on_trigger_error(str(e) or e.__class__.__name__)

    def shutdown(self) -> None:
        for t in list(self.tasks):
            self._stop_loop(t.id)
            t.running = False
        self.cancel_pending()
