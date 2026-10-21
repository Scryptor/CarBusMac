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


def layout_kinds(info: dict[str, Any]) -> dict[int, list[str]]:
    """Тип каждого слота по каналам, в порядке записей `filters_info`: "std" — только
    11-битные ID, "ext" — только 29-битные, "any" — оба или прибор не сказал. У части
    приборов банки раздельные (по README carbus-lib: 11 бит — 0..27, 29 бит — 28..35)."""
    kinds: dict[int, list[str]] = {}
    for f in info.get("filters_info") or []:
        try:
            ch, size = int(f["channel"]), int(f["size"])
        except (KeyError, TypeError, ValueError):
            continue
        if ch <= 0 or size <= 0:
            continue
        has11, has29 = f.get("has_11bit"), f.get("has_29bit")
        kind = "std" if has11 and not has29 else "ext" if has29 and not has11 else "any"
        kinds.setdefault(ch, []).extend([kind] * size)
    return kinds


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
            for e in d.get("exclusions") or [] if isinstance(e, dict)]
    channel = int(d.get("channel", 1))
    if channel not in (1, 2):
        raise ValueError("канал диапазона — 1 или 2")
    return RangeFilter(str(d.get("id") or ""), channel, bool(d.get("enabled", True)), start, end, excl)


class HwFilters:
    def __init__(self, layout: dict[int, int], kinds: dict[int, list[str]] | None = None) -> None:
        self.layout = dict(layout)
        self.kinds = {ch: list(v) for ch, v in (kinds or {}).items()}
        self.slots = [HwSlot(ch, i) for ch in sorted(layout) for i in range(layout[ch])]

    def _find(self, channel: int, index: int) -> int:
        for k, s in enumerate(self.slots):
            if s.channel == channel and s.index == index:
                return k
        raise ValueError(f"нет фильтра {index} на канале {channel}")

    def kind(self, channel: int, index: int) -> str:
        k = self.kinds.get(channel) or []
        return k[index] if 0 <= index < len(k) else "any"

    def check(self, slot: HwSlot) -> None:
        """Слот есть у прибора и подходит по типу ID (у раздельных банков 11/29 бит)."""
        self._find(slot.channel, slot.index)
        kind = self.kind(slot.channel, slot.index)
        if kind == "std" and slot.ext:
            raise ValueError(f"Фильтр {slot.index} канала {slot.channel} — только для 11-битных ID")
        if kind == "ext" and not slot.ext:
            raise ValueError(f"Фильтр {slot.index} канала {slot.channel} — только для 29-битных ID")

    def set(self, slot: HwSlot) -> None:
        self.check(slot)
        self.slots[self._find(slot.channel, slot.index)] = slot

    def _fits(self, s: HwSlot, ext: bool) -> bool:
        kind = self.kind(s.channel, s.index)
        return kind == "any" or kind == ("ext" if ext else "std")

    def slot_for_id(self, channel: int, can_id: int, ext: bool) -> HwSlot | None:
        """Слот для «Добавить ID в фильтр»: тот, где ровно этот ID (полная маска) уже стоит,
        иначе первый нетронутый. Фильтр с другой маской или выключенный пользователем — чужая
        настройка, её не трогаем."""
        mine = [s for s in self.slots if s.channel == channel and self._fits(s, ext)]
        same = next((s for s in mine if s.can_id == can_id and s.ext == ext and s.mask == _max_id(ext)), None)
        if same is not None:
            return same
        return next((s for s in mine if not s.enabled and s.can_id == 0 and not s.ext
                     and s.mask in (0x7FF, 0x1FFFFFFF)), None)

    def first_free(self, channel: int) -> HwSlot | None:
        return next((s for s in self.slots if s.channel == channel and not s.enabled), None)

    def to_list(self) -> list[dict[str, Any]]:
        return [{**s.__dict__, "kind": self.kind(s.channel, s.index)} for s in self.slots]

    def load_list(self, items: list[dict[str, Any]]) -> None:
        for d in items:
            if not isinstance(d, dict):
                continue
            try:
                self.set(slot_from_dict(d))
            except (KeyError, TypeError, ValueError):
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
            if not isinstance(d, dict):
                continue
            try:
                self.upsert(range_from_dict(d))
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
