"""Передача: одиночная отправка (shot), периодические задачи и триггеры
(авто-отправка по приёму совпавшего кадра). Всё идёт через CanSession.send,
поэтому тестируется на FakeSession; `sleep` инъектируется для детерминизма."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable

from app.can_session import CanSession
from app.models import CanFrame


@dataclass
class TxTask:
    id: str
    frame: CanFrame
    period_ms: int | None = None   # None → одиночная (через shot); иначе период


@dataclass
class Trigger:
    match_channel: int
    match_id: int
    match_data: bytes
    match_mask: bytes
    action: CanFrame


def _masked_match(frame: CanFrame, t: Trigger) -> bool:
    if frame.channel != t.match_channel or frame.can_id != t.match_id:
        return False
    if len(frame.data) < len(t.match_data):
        return False
    for i in range(len(t.match_data)):
        m = t.match_mask[i] if i < len(t.match_mask) else 0  # короткая маска: остальное — wildcard
        if (frame.data[i] & m) != (t.match_data[i] & m):
            return False
    return True


class TransmitManager:
    def __init__(
        self,
        session: CanSession,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._session = session
        self._sleep = sleep
        self._defs: dict[str, TxTask] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self._triggers: dict[str, Trigger] = {}
        self._trigger_seq = 0

    async def shot(self, frame: CanFrame) -> None:
        await self._session.send(frame)

    def add_task(self, task: TxTask) -> str:
        self._defs[task.id] = task
        return task.id

    async def run(self, task_id: str) -> None:
        task = self._defs[task_id]
        if task.period_ms is None:
            await self._session.send(task.frame)
            return
        self.tasks[task_id] = asyncio.create_task(self._loop(task))

    async def _loop(self, task: TxTask) -> None:
        assert task.period_ms is not None
        while True:
            await self._session.send(task.frame)
            await self._sleep(task.period_ms / 1000.0)

    def stop(self, task_id: str) -> None:
        t = self.tasks.pop(task_id, None)
        if t is not None:
            t.cancel()

    async def run_all(self) -> None:
        for tid in list(self._defs):
            await self.run(tid)

    def stop_all(self) -> None:
        for tid in list(self.tasks):
            self.stop(tid)

    def add_trigger(self, trigger: Trigger) -> str:
        self._trigger_seq += 1
        tid = f"trg{self._trigger_seq}"
        self._triggers[tid] = trigger
        return tid

    def remove_trigger(self, trigger_id: str) -> None:
        self._triggers.pop(trigger_id, None)

    async def on_frame(self, frame: CanFrame) -> None:
        for t in self._triggers.values():
            if _masked_match(frame, t):
                await self._session.send(t.action)
