"""Агрегация приёма по ID с коалесценцией: произвольный поток кадров сводится к
состоянию «по одному на ID», а `snapshot_delta()` отдаёт только изменившееся.
Вызывающий (сервер) дёргает снапшот на фиксированной частоте, поэтому высокая
загрузка шины не затапливает UI и не теряет последнее значение."""
from __future__ import annotations

from dataclasses import dataclass, field

from app.models import CanFrame


@dataclass
class MonitorRow:
    channel: int
    can_id: int
    extended: bool
    dlc: int
    data: bytes
    count: int
    period_ms: float | None
    changed_mask: int
    last_ts: float


@dataclass
class _Entry:
    extended: bool
    data: bytes = b""
    count: int = 0
    last_ts: float = 0.0
    period_ms: float | None = None
    baseline: bytes | None = None   # данные на момент прошлого снапшота
    dirty: bool = False
    _has_ts: bool = field(default=False, repr=False)


def _changed_mask(cur: bytes, base: bytes | None) -> int:
    if base is None:
        return (1 << len(cur)) - 1
    mask = 0
    for i in range(max(len(cur), len(base))):
        cb = cur[i] if i < len(cur) else None
        bb = base[i] if i < len(base) else None
        if cb != bb:
            mask |= 1 << i
    return mask


class MonitorState:
    def __init__(self) -> None:
        self._entries: dict[tuple[int, int, bool], _Entry] = {}

    def update(self, frame: CanFrame) -> None:
        key = (frame.channel, frame.can_id, frame.extended)
        e = self._entries.get(key)
        if e is None:
            e = _Entry(extended=frame.extended)
            self._entries[key] = e
        if e._has_ts:
            e.period_ms = (frame.timestamp - e.last_ts) * 1000.0
        e.last_ts = frame.timestamp
        e._has_ts = True
        e.data = frame.data
        e.count += 1
        e.dirty = True

    def snapshot_delta(self) -> list[MonitorRow]:
        rows: list[MonitorRow] = []
        for (channel, can_id, extended), e in self._entries.items():
            if not e.dirty:
                continue
            rows.append(
                MonitorRow(
                    channel=channel,
                    can_id=can_id,
                    extended=extended,
                    dlc=len(e.data),
                    data=e.data,
                    count=e.count,
                    period_ms=e.period_ms,
                    changed_mask=_changed_mask(e.data, e.baseline),
                    last_ts=e.last_ts,
                )
            )
            e.baseline = e.data
            e.dirty = False
        return rows

    def clear(self) -> None:
        self._entries.clear()
