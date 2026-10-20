"""Агрегация приёма по ID с коалесценцией: произвольный поток кадров сводится к
состоянию «по одному на ID», а `snapshot_delta()` отдаёт только изменившееся.
Вызывающий (сервер) дёргает снапшот на фиксированной частоте, поэтому высокая
загрузка шины не затапливает UI и не теряет последнее значение.

Для подсветки «редких данных» на каждый байт хранится, сколько он был неизменен до
своего последнего изменения (`stable_ms`). Агрегатор уникальных данных (колонка FC и
окно «Данные сообщения» десктопа) копит различные payload по ID, не больше `unique_cap`."""
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
    rtr: bool = False
    fd: bool = False
    brs: bool = False
    stable_ms: list[float | None] = field(default_factory=list)
    fc: int = 0


@dataclass
class UniqueFrame:
    data: bytes
    count: int
    period_ms: float | None
    last_ts: float


@dataclass
class _Entry:
    extended: bool
    data: bytes = b""
    rtr: bool = False
    fd: bool = False
    brs: bool = False
    count: int = 0
    first_ts: float = 0.0
    last_ts: float = 0.0
    period_ms: float | None = None
    baseline: bytes | None = None   # данные на момент прошлого снапшота
    dirty: bool = False
    byte_change_ts: list[float | None] = field(default_factory=list)
    stable_ms: list[float | None] = field(default_factory=list)
    uniq: dict[bytes, UniqueFrame] = field(default_factory=dict)
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
    def __init__(self, aggregator: bool = False, unique_cap: int = 4096) -> None:
        self._entries: dict[tuple[int, int, bool], _Entry] = {}
        self.aggregator = aggregator
        self.unique_cap = unique_cap

    def set_aggregator(self, on: bool) -> None:
        self.aggregator = on
        if not on:
            for e in self._entries.values():
                e.uniq.clear()

    def update(self, frame: CanFrame) -> None:
        key = (frame.channel, frame.can_id, frame.extended)
        ts = frame.timestamp
        e = self._entries.get(key)
        if e is None:
            e = _Entry(extended=frame.extended, first_ts=ts)
            self._entries[key] = e
        if e._has_ts:
            e.period_ms = (ts - e.last_ts) * 1000.0
            self._track_bytes(e, frame.data, ts)
        else:
            e.byte_change_ts = [None] * len(frame.data)
            e.stable_ms = [None] * len(frame.data)
        e.last_ts = ts
        e._has_ts = True
        e.data = frame.data
        e.rtr, e.fd, e.brs = frame.rtr, frame.fd, frame.brs
        e.count += 1
        e.dirty = True
        if self.aggregator:
            self._aggregate(e, frame.data, ts)

    @staticmethod
    def _track_bytes(e: _Entry, data: bytes, ts: float) -> None:
        n = len(data)
        if len(e.byte_change_ts) < n:
            e.byte_change_ts += [None] * (n - len(e.byte_change_ts))
            e.stable_ms += [None] * (n - len(e.stable_ms))
        for i in range(n):
            old = e.data[i] if i < len(e.data) else None
            if old != data[i]:
                since = e.byte_change_ts[i]
                e.stable_ms[i] = (ts - (e.first_ts if since is None else since)) * 1000.0
                e.byte_change_ts[i] = ts

    def _aggregate(self, e: _Entry, data: bytes, ts: float) -> None:
        u = e.uniq.get(data)
        if u is None:
            if len(e.uniq) >= self.unique_cap:
                return
            e.uniq[data] = UniqueFrame(data=data, count=1, period_ms=None, last_ts=ts)
            return
        u.period_ms = (ts - u.last_ts) * 1000.0
        u.last_ts = ts
        u.count += 1

    def _row(self, key: tuple[int, int, bool], e: _Entry, mask: int) -> MonitorRow:
        channel, can_id, extended = key
        n = len(e.data)
        return MonitorRow(
            channel=channel,
            can_id=can_id,
            extended=extended,
            dlc=n,
            data=e.data,
            count=e.count,
            period_ms=e.period_ms,
            changed_mask=mask,
            last_ts=e.last_ts,
            rtr=e.rtr,
            fd=e.fd,
            brs=e.brs,
            stable_ms=list(e.stable_ms[:n]),
            fc=len(e.uniq),
        )

    def snapshot_delta(self) -> list[MonitorRow]:
        rows: list[MonitorRow] = []
        for key, e in self._entries.items():
            if not e.dirty:
                continue
            rows.append(self._row(key, e, _changed_mask(e.data, e.baseline)))
            e.baseline = e.data
            e.dirty = False
        return rows

    def snapshot_all(self) -> list[MonitorRow]:
        """Все строки для только что подключившегося клиента; дельту не потребляет."""
        return [self._row(key, e, 0) for key, e in self._entries.items()]

    def unique_frames(self, channel: int, can_id: int, extended: bool) -> list[UniqueFrame]:
        e = self._entries.get((channel, can_id, extended))
        return list(e.uniq.values()) if e else []

    def clear(self) -> None:
        self._entries.clear()
