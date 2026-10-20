"""Фильтры приёма (панель фильтров десктопа).

Аппаратные («Фильтр ID/Маска»): слоты прибора по каналам, число слотов берётся из
`filters_info` device_info. Слот включён → прибор принимает только кадры, у которых
биты ID под маской совпадают со значением; все слоты выключены → принимается всё.

Программные («Фильтр Диапазон»): диапазоны ID по каналам с исключениями ID/Маска.
Отсеивают кадры до монитора, потока и записи. Нет включённых диапазонов у канала —
канал принимает всё."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models import CanFrame

DEFAULT_SLOTS = 14


@dataclass
class HwSlot:
    channel: int
    index: int
    enabled: bool = False
    can_id: int = 0
    mask: int = 0x7FF
    ext: bool = False


@dataclass
class RangeExclusion:
    enabled: bool = True
    can_id: int = 0
    mask: int = 0x7FF


@dataclass
class RangeFilter:
    id: str
    channel: int
    enabled: bool = True
    start: int = 0
    end: int = 0x7FF
    exclusions: list[RangeExclusion] = field(default_factory=list)


def _max_id(ext: bool) -> int:
    return 0x1FFFFFFF if ext else 0x7FF


def layout_from_device(info: dict[str, Any]) -> dict[int, int]:
    layout: dict[int, int] = {}
    for f in info.get("filters_info") or []:
        try:
            ch, size = int(f["channel"]), int(f["size"])
        except (KeyError, TypeError, ValueError):
            continue
        if ch > 0 and size > 0:
            layout[ch] = layout.get(ch, 0) + size
    return layout or {1: DEFAULT_SLOTS, 2: DEFAULT_SLOTS}


def slot_from_dict(d: dict[str, Any]) -> HwSlot:
    ext = bool(d.get("ext", False))
    can_id = int(d.get("can_id", 0))
    mask = int(d.get("mask", _max_id(ext)))
    if not 0 <= can_id <= _max_id(ext) or not 0 <= mask <= _max_id(ext):
        raise ValueError("ID или маска вне диапазона")
    return HwSlot(int(d["channel"]), int(d["index"]), bool(d.get("enabled", False)), can_id, mask, ext)


def range_from_dict(d: dict[str, Any]) -> RangeFilter:
    start, end = int(d.get("start", 0)), int(d.get("end", 0x7FF))
    if start > end:
        start, end = end, start
    if start < 0 or end > 0x1FFFFFFF:
        raise ValueError("диапазон вне 0..1FFFFFFF")
    excl = [RangeExclusion(bool(e.get("enabled", True)), int(e.get("can_id", 0)), int(e.get("mask", 0x7FF)))
            for e in d.get("exclusions") or []]
    return RangeFilter(str(d.get("id") or ""), int(d.get("channel", 1)), bool(d.get("enabled", True)),
                       start, end, excl)


class HwFilters:
    def __init__(self, layout: dict[int, int]) -> None:
        self.layout = dict(layout)
        self.slots = [HwSlot(ch, i) for ch in sorted(layout) for i in range(layout[ch])]

    def _find(self, channel: int, index: int) -> int:
        for k, s in enumerate(self.slots):
            if s.channel == channel and s.index == index:
                return k
        raise ValueError(f"нет фильтра {index} на канале {channel}")

    def set(self, slot: HwSlot) -> None:
        self.slots[self._find(slot.channel, slot.index)] = slot

    def first_free(self, channel: int) -> HwSlot | None:
        return next((s for s in self.slots if s.channel == channel and not s.enabled), None)

    def to_list(self) -> list[dict[str, Any]]:
        return [dict(s.__dict__) for s in self.slots]

    def load_list(self, items: list[dict[str, Any]]) -> None:
        for d in items:
            try:
                self.set(slot_from_dict(d))
            except (KeyError, ValueError):
                continue   # слот другого прибора — пропускаем


class SoftFilters:
    def __init__(self) -> None:
        self.ranges: list[RangeFilter] = []

    def upsert(self, r: RangeFilter) -> None:
        for k, old in enumerate(self.ranges):
            if old.id == r.id:
                self.ranges[k] = r
                return
        self.ranges.append(r)

    def delete(self, rid: str) -> None:
        self.ranges = [r for r in self.ranges if r.id != rid]

    def accept(self, f: CanFrame) -> bool:
        active = [r for r in self.ranges if r.enabled and r.channel == f.channel]
        if not active:
            return True
        for r in active:
            if r.start <= f.can_id <= r.end and not any(
                e.enabled and (f.can_id & e.mask) == (e.can_id & e.mask) for e in r.exclusions
            ):
                return True
        return False

    def to_list(self) -> list[dict[str, Any]]:
        return [{**r.__dict__, "exclusions": [dict(e.__dict__) for e in r.exclusions]} for r in self.ranges]

    def load_list(self, items: list[dict[str, Any]]) -> None:
        self.ranges = []
        for d in items:
            try:
                self.upsert(range_from_dict(d))
            except (TypeError, ValueError):
                continue
