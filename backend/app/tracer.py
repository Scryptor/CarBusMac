"""Отладчик (окно «Отладчик» десктопа): документ трейса и проигрыватель.

Документ — строки трейса с флагами «разрешена», точка останова, задержки до/после и
комментарий; таблица ID — «фильтр сообщений»: строки неотмеченных ID скрыты из таблицы
и не воспроизводятся. Интерфейс адресует строки позициями среди видимых («pos»), документ
хранит и правит их по индексам («i»).
Проигрыватель шлёт строки в шину (Канал 1/Канал 2 — канал кадра переписывается) или
в окно Приём, с паузой между строками по меткам времени («Макс. 1 сек» обрезает
большие паузы) или фиксированной; останавливается перед точкой останова и при приёме
данных (если включено), умеет шаг, цикл и воспроизведение только выделенных строк."""
from __future__ import annotations

import asyncio
from bisect import bisect_left
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable

from app.capture import Marker
from app.models import CanFrame
from app.tracefmt import TraceDoc

IdKey = tuple[int, int, bool]
DELAY_MODES = ("timestamp", "fixed")
DESTS = ("ch1", "ch2", "monitor")


@dataclass
class TraceRow:
    frame: CanFrame
    enabled: bool = True
    bp: bool = False
    before_ms: int = 0
    after_ms: int = 0
    comment: str = ""
    start: bool = False     # «Установить начало»: воспроизведение — с этой строки
    finish: bool = False    # «Установить конец»: и до этой


def _key(f: CanFrame) -> IdKey:
    return (f.channel, f.can_id, f.extended)


class TracerDoc:
    def __init__(self) -> None:
        self.name: str | None = None
        self.rows: list[TraceRow] = []
        self.markers: list[Marker] = []
        self.modified = False
        self._disabled_ids: set[IdKey] = set()
        self._visible: list[int] | None = None   # индексы видимых строк, по возрастанию

    def load(self, doc: TraceDoc, name: str | None) -> None:
        self.name = name
        self.rows = [TraceRow(f, comment=doc.comments.get(i, "")) for i, f in enumerate(doc.frames)]
        self.markers = list(doc.markers)
        self._disabled_ids = set()
        self._visible = None
        self.modified = False

    # --- видимые строки (фильтр по ID) ---
    def visible(self) -> list[int]:
        if self._visible is None:
            if self._disabled_ids:
                self._visible = [i for i, r in enumerate(self.rows) if _key(r.frame) not in self._disabled_ids]
            else:
                self._visible = list(range(len(self.rows)))
        return self._visible

    def visible_count(self) -> int:
        return len(self.visible())

    def indices(self, positions: list[int]) -> list[int]:
        vis = self.visible()
        return [vis[p] for p in positions if 0 <= p < len(vis)]

    def position(self, index: int) -> int | None:
        vis = self.visible()
        p = bisect_left(vis, index)
        return p if p < len(vis) and vis[p] == index else None

    def find(self, key: IdKey) -> list[int]:
        key = (int(key[0]), int(key[1]), bool(key[2]))
        return [p for p, i in enumerate(self.visible()) if _key(self.rows[i].frame) == key]

    def to_trace_doc(self) -> TraceDoc:
        return TraceDoc(
            frames=[r.frame for r in self.rows],
            markers=list(self.markers),
            comments={i: r.comment for i, r in enumerate(self.rows) if r.comment},
        )

    # --- просмотр ---
    def rows_view(self, start: int, count: int) -> list[dict[str, Any]]:
        vis = self.visible()
        start = max(0, start)
        end = min(len(vis), start + max(0, count))
        t0 = self.rows[0].frame.timestamp if self.rows else 0.0
        marks = {m.index: m for m in self.markers}
        out = []
        for pos in range(start, end):
            i = vis[pos]
            r = self.rows[i]
            f = r.frame
            m = marks.get(i)
            out.append({
                "i": i, "pos": pos, "t": round(f.timestamp - t0, 6), "ch": f.channel, "dir": f.direction,
                "id": f.can_id, "ext": f.extended, "rtr": f.rtr, "dlc": len(f.data),
                "data": f.data.hex(), "enabled": r.enabled, "bp": r.bp, "start": r.start, "finish": r.finish,
                "before_ms": r.before_ms, "after_ms": r.after_ms, "comment": r.comment,
                "marker": {"label": m.label, "comment": m.comment} if m else None,
            })
        return out

    def ids(self) -> list[dict[str, Any]]:
        counts: dict[IdKey, int] = {}
        for r in self.rows:
            k = _key(r.frame)
            counts[k] = counts.get(k, 0) + 1
        return [{"ch": k[0], "id": k[1], "ext": k[2], "count": n, "enabled": k not in self._disabled_ids}
                for k, n in sorted(counts.items())]

    def channels(self) -> list[int]:
        return sorted({r.frame.channel for r in self.rows})

    def set_ids_enabled(self, keys: list[IdKey], on: bool) -> None:
        for k in keys:
            k = (int(k[0]), int(k[1]), bool(k[2]))
            if on:
                self._disabled_ids.discard(k)
            else:
                self._disabled_ids.add(k)
        self._visible = None

    def playable(self, i: int, only_channel: int | None) -> bool:
        r = self.rows[i]
        return (r.enabled and _key(r.frame) not in self._disabled_ids
                and (only_channel is None or r.frame.channel == only_channel))

    # --- правка ---
    def add(self, row: TraceRow, index: int | None) -> int:
        if index is None or index >= len(self.rows):
            self.rows.append(row)
            idx = len(self.rows) - 1
        else:
            idx = max(0, index)
            self.rows.insert(idx, row)
            for m in self.markers:
                if m.index >= idx:
                    m.index += 1
        self._visible = None
        self.modified = True
        return idx

    def edit(self, index: int, row: TraceRow) -> None:
        self.rows[index] = row
        self._visible = None
        self.modified = True

    def delete(self, indices: list[int]) -> None:
        drop = sorted({i for i in indices if 0 <= i < len(self.rows)})
        if not drop:
            return
        dropset = set(drop)
        self.rows = [r for i, r in enumerate(self.rows) if i not in dropset]
        for m in self.markers:
            m.index -= sum(1 for d in drop if d < m.index)
        self._visible = None
        self.modified = True

    def set_enabled(self, indices: list[int], on: bool) -> None:
        for i in indices:
            if 0 <= i < len(self.rows):
                self.rows[i].enabled = on

    def set_enabled_by_id(self, key: IdKey, on: bool) -> None:
        key = (int(key[0]), int(key[1]), bool(key[2]))
        for r in self.rows:
            if _key(r.frame) == key:
                r.enabled = on

    def set_bp(self, index: int, on: bool) -> None:
        self.rows[index].bp = on

    def set_bound(self, which: str, index: int | None) -> None:
        """Начало/конец воспроизведения — одна строка на трейс; повтор на той же строке снимает."""
        if which not in ("start", "finish"):
            raise ValueError(f"неизвестная граница: {which}")
        was = index is not None and getattr(self.rows[index], which)
        for r in self.rows:
            setattr(r, which, False)
        if index is not None and not was:
            setattr(self.rows[index], which, True)

    def bounds(self) -> tuple[int, int]:
        rows = self.rows
        lo = next((i for i, r in enumerate(rows) if r.start), 0)
        hi = next((i for i, r in enumerate(rows) if r.finish), len(rows) - 1)
        return min(lo, hi), max(lo, hi)

    def set_comment(self, index: int, text: str) -> None:
        self.rows[index].comment = text
        self.modified = True


@dataclass
class PlayerConfig:
    delay_mode: str = "timestamp"
    fixed_ms: int = 100
    max_1s: bool = False
    loop: bool = False
    dest: str = "ch1"
    only_channel: int | None = None
    stop_on_bp: bool = True
    stop_on_rx: bool = False

    @staticmethod
    def from_patch(cfg: "PlayerConfig", patch: dict[str, Any]) -> "PlayerConfig":
        out = replace(cfg)
        for k, v in patch.items():
            if not hasattr(out, k):
                continue
            if k == "delay_mode" and v not in DELAY_MODES:
                raise ValueError(f"неизвестный режим паузы: {v}")
            if k == "dest" and v not in DESTS:
                raise ValueError(f"неизвестная точка назначения: {v}")
            if k == "fixed_ms":
                v = int(v)
                if not 10 <= v <= 9999:
                    raise ValueError("пауза вне 10..9999 мс")
            if k == "only_channel":
                v = None if v in (None, "", 0) else int(v)
            if k in ("max_1s", "loop", "stop_on_bp", "stop_on_rx"):
                v = bool(v)
            setattr(out, k, v)
        return out


class TracePlayer:
    def __init__(
        self,
        doc: TracerDoc,
        send: Callable[[CanFrame, str], Awaitable[None]],
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_progress: Callable[[int | None, str], None] = lambda current, state: None,
    ) -> None:
        self.doc = doc
        self._send = send
        self._sleep = sleep
        self._on_progress = on_progress
        self.config = PlayerConfig()
        self.state = "stopped"
        self.current: int | None = None
        self.cursor = 0                       # позиция в порядке воспроизведения
        self._selection: list[int] | None = None
        self._bp_passed: int | None = None
        self._task: asyncio.Task | None = None

    def _emit(self) -> None:
        self._on_progress(self.current, self.state)

    def _order(self) -> list[int]:
        if self._selection is not None:
            return [i for i in self._selection if 0 <= i < len(self.doc.rows)]
        if not self.doc.rows:
            return []
        lo, hi = self.doc.bounds()
        return list(range(lo, hi + 1))

    def _cancel(self) -> None:
        if self._task is not None and self._task is not asyncio.current_task():
            self._task.cancel()
        self._task = None

    async def play(self, selection: list[int] | None = None) -> None:
        if self.state == "playing":
            return
        if self.state == "stopped":
            self._selection = sorted(set(selection)) if selection else None
            self.cursor = 0
            self._bp_passed = None
        self.state = "playing"
        self._emit()
        self._task = asyncio.create_task(self._run())

    def pause(self) -> None:
        if self.state != "playing":
            return
        self._cancel()
        self.state = "paused"
        self._emit()

    def stop(self) -> None:
        self._cancel()
        self.state = "stopped"
        self.current = None
        self.cursor = 0
        self._emit()

    def notify_rx(self) -> None:
        if self.state == "playing" and self.config.stop_on_rx:
            self.pause()

    async def step(self) -> None:
        if self.state == "playing":
            return
        if self.state == "stopped":
            self._selection = None
            self.cursor = 0
        order = self._order()
        while self.cursor < len(order) and not self.doc.playable(order[self.cursor], self.config.only_channel):
            self.cursor += 1
        if self.cursor >= len(order):
            self.stop()
            return
        idx = order[self.cursor]
        self.cursor += 1
        self.state = "paused"
        await self._send_row(idx)

    def _gap(self, prev_ts: float, ts: float) -> float:
        if self.config.delay_mode == "fixed":
            return self.config.fixed_ms / 1000.0
        d = max(0.0, ts - prev_ts)
        return min(d, 1.0) if self.config.max_1s else d

    async def _send_row(self, idx: int) -> None:
        f = self.doc.rows[idx].frame
        if self.config.dest == "monitor":
            out, target = f, "monitor"
        else:
            out, target = replace(f, channel=1 if self.config.dest == "ch1" else 2, direction="tx"), "bus"
        self.current = idx
        await self._send(out, target)
        self._emit()

    async def _run(self) -> None:
        order = self._order()
        prev_ts: float | None = None
        while True:
            while self.cursor < len(order):
                idx = order[self.cursor]
                row = self.doc.rows[idx]
                if not self.doc.playable(idx, self.config.only_channel):
                    self.cursor += 1
                    continue
                if row.bp and self.config.stop_on_bp and self._bp_passed != idx:
                    self._bp_passed = idx
                    self.current = idx
                    self.state = "paused"
                    self._task = None
                    self._emit()
                    return
                delay = row.before_ms / 1000.0
                if prev_ts is not None:
                    delay += self._gap(prev_ts, row.frame.timestamp)
                if delay > 0:
                    await self._sleep(delay)
                await self._send_row(idx)
                prev_ts = row.frame.timestamp
                self.cursor += 1
                if self.state != "playing":     # пауза изнутри send (например, приём данных)
                    return
                if row.after_ms:
                    await self._sleep(row.after_ms / 1000.0)
            if not self.config.loop:
                break
            self.cursor = 0
            prev_ts = None
            self._bp_passed = None
            await asyncio.sleep(0)            # цикл без пауз не должен вешать event loop
        self.state = "stopped"
        self.cursor = 0
        self._task = None
        self._emit()
