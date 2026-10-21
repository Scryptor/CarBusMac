"""Буфер потока (режим «Поток» десктопа): запись/пауза, очистка, метки, выдача
диапазонов строк для виртуальной таблицы фронта. Хранение колоночное (array +
bytearray по 8 байт на кадр), чтобы часы записи на загруженной шине не съедали
память объектами Python; payload длиннее 8 байт (CAN-FD) — в отдельном словаре.

`snapshot()` даёт копию колонок — по ней файл пишется в отдельном потоке, пока запись
и передача продолжаются. У RTR-кадра данных нет, а DLC есть: такой кадр хранит DLC
нулевых байт (в строках таблицы данные RTR пустые)."""
from __future__ import annotations

from array import array
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Callable, Iterator, Sequence

from app.models import CanFrame

_EXT, _RTR, _FD, _BRS, _TX, _ARRIVAL = 1, 2, 4, 8, 16, 32


@dataclass
class Marker:
    index: int          # метка стоит перед кадром с этим индексом
    label: str
    comment: str
    auto: bool = False


def copy_markers(markers: list[Marker]) -> list[Marker]:
    """Метки потока и отладчика — разные объекты: правка трейса не сдвигает метки потока."""
    return [replace(m) for m in markers]


class FrameColumns(Sequence[CanFrame]):
    """Кадры, хранящиеся колонками; отдаёт CanFrame по индексу и по порядку."""

    def __init__(self, ts: array, ch: array, flags: array, dlc: array, ids: array, data: bytearray | bytes,
                 long: dict[int, bytes]) -> None:
        self._ts, self._ch, self._flags, self._dlc, self._id = ts, ch, flags, dlc, ids
        self._data, self._long = data, long

    def __len__(self) -> int:
        return len(self._ts)

    def __getitem__(self, i):  # type: ignore[override]
        if isinstance(i, slice):
            return [self._frame(k) for k in range(*i.indices(len(self)))]
        if i < 0:
            i += len(self)
        if not 0 <= i < len(self):
            raise IndexError(i)
        return self._frame(i)

    def __iter__(self) -> Iterator[CanFrame]:
        for i in range(len(self)):
            yield self._frame(i)

    def _frame(self, i: int) -> CanFrame:
        flags = self._flags[i]
        dlc = self._dlc[i]
        data = self._long.get(i) or bytes(self._data[i * 8:i * 8 + min(dlc, 8)])
        return CanFrame(
            channel=self._ch[i],
            can_id=self._id[i],
            data=data,
            extended=bool(flags & _EXT),
            rtr=bool(flags & _RTR),
            fd=bool(flags & _FD),
            brs=bool(flags & _BRS),
            timestamp=self._ts[i],
            ts_source="arrival" if flags & _ARRIVAL else "device",
            direction="tx" if flags & _TX else "rx",
        )


class Capture:
    def __init__(self, limit: int = 5_000_000, now: Callable[[], datetime] | None = None) -> None:
        self.limit = limit
        self.recording = False
        self.full = False
        self.markers: list[Marker] = []
        self.meta: dict[str, str] = {}          # метаинформация загруженного трейса
        self.started_at: datetime | None = None  # местное время первого записанного кадра
        self.loaded: str | None = None           # из какого файла буфер (None — записан здесь)
        self.dirty = False                       # есть несохранённое: записанные кадры или метки
        self._now = now
        self._reset()

    def _reset(self) -> None:
        self._ts = array("d")
        self._ch = array("B")
        self._flags = array("B")
        self._dlc = array("B")
        self._id = array("I")
        self._data = bytearray()
        self._long: dict[int, bytes] = {}
        self.t0: float | None = None

    # --- управление записью ---
    def start(self) -> None:
        if not self.full:
            self.recording = True

    def pause(self) -> None:
        self.recording = False

    def clear(self) -> None:
        self._reset()
        self.markers = []
        self.meta = {}
        self.started_at = None
        self.full = False
        self.loaded = None
        self.dirty = False

    def __len__(self) -> int:
        return len(self._ts)

    def append(self, f: CanFrame) -> bool:
        if not self.recording:
            return False
        if len(self) >= self.limit:
            self.full = True
            self.recording = False
            return False
        if not len(self) and self._now is not None:
            self.started_at = self._now()
        self._push(f)
        self.dirty = True
        if len(self) >= self.limit:            # буфер заполнен — запись встаёт сразу
            self.full = True
            self.recording = False
        return True

    def _push(self, f: CanFrame) -> None:
        if self.t0 is None:
            self.t0 = f.timestamp
        flags = ((_EXT if f.extended else 0) | (_RTR if f.rtr else 0) | (_FD if f.fd else 0)
                 | (_BRS if f.brs else 0) | (_TX if f.direction == "tx" else 0)
                 | (_ARRIVAL if f.ts_source != "device" else 0))
        i = len(self._ts)
        self._ts.append(f.timestamp)
        self._ch.append(f.channel & 0xFF)
        self._flags.append(flags)
        self._dlc.append(min(len(f.data), 255))
        self._id.append(f.can_id & 0xFFFFFFFF)
        self._data += f.data[:8].ljust(8, b"\x00")
        if len(f.data) > 8:
            self._long[i] = bytes(f.data)

    # --- чтение ---
    def _columns(self) -> FrameColumns:
        return FrameColumns(self._ts, self._ch, self._flags, self._dlc, self._id, self._data, self._long)

    def frame(self, i: int) -> CanFrame:
        return self._columns()._frame(i)

    def frames(self) -> list[CanFrame]:
        return list(self._columns())

    def snapshot(self) -> FrameColumns:
        """Копия колонок (быстро: копирование массивов) — её можно читать из другого потока."""
        return FrameColumns(array("d", self._ts), array("B", self._ch), array("B", self._flags),
                            array("B", self._dlc), array("I", self._id), bytes(self._data), dict(self._long))

    def rows(self, start: int, count: int) -> list[dict]:
        start = max(0, start)
        end = min(len(self), start + max(0, count))
        marks: dict[int, list[Marker]] = {}
        for m in self.markers:
            marks.setdefault(m.index, []).append(m)
        t0 = self.t0 or 0.0
        cols = self._columns()
        out = []
        for i in range(start, end):
            f = cols._frame(i)
            ms = marks.get(i)
            out.append({
                "i": i,
                "t": round(f.timestamp - t0, 6),
                "ch": f.channel,
                "dir": f.direction,
                "id": f.can_id,
                "ext": f.extended,
                "rtr": f.rtr,
                "dlc": len(f.data),
                "data": "" if f.rtr else f.data.hex(),
                "marker": marker_view(ms) if ms else None,
            })
        return out

    def unique_frames(self, channel: int, can_id: int, extended: bool, limit: int = 4096) -> Callable[[], list[dict]]:
        """«Данные сообщения» по буферу потока: различные payload одного ID со счётчиком и
        последним периодом. Возвращает функцию для отдельного потока: колонки и длина берутся
        сейчас, а запись дальше только дописывает (и `clear` заменяет массивы, не трогая
        старые), поэтому прочитанная часть не меняется."""
        n, ts, ch, flags, ids, data, long_ = (len(self), self._ts, self._ch, self._flags, self._id,
                                              self._data, self._long)
        dlc, ext_flag = self._dlc, _EXT if extended else 0

        def scan() -> list[dict]:
            seen: dict[bytes, dict] = {}
            for i in range(n):
                if ids[i] != can_id or ch[i] != channel or (flags[i] & _EXT) != ext_flag:
                    continue
                payload = long_.get(i) or bytes(data[8 * i: 8 * i + dlc[i]])
                u = seen.get(payload)
                if u is None:
                    if len(seen) < limit:
                        seen[payload] = {"data": payload.hex(), "count": 1, "period_ms": None, "ts": ts[i]}
                    continue
                u["period_ms"] = (ts[i] - u["ts"]) * 1000.0
                u["ts"] = ts[i]
                u["count"] += 1
            return list(seen.values())
        return scan

    def add_marker(self, label: str, comment: str, auto: bool = False) -> Marker:
        m = Marker(len(self), label, comment, auto)
        self.markers.append(m)
        self.dirty = True
        return m

    def load(self, frames: Sequence[CanFrame], markers: list[Marker], meta: dict[str, str] | None = None) -> None:
        """Заменить буфер загруженным трейсом; запись при этом останавливается."""
        self.clear()
        self.recording = False
        for f in frames:
            self._push(f)
        self.markers = copy_markers(markers)
        self.meta = dict(meta or {})
        self.full = len(self) >= self.limit

    def adopt(self, other: "Capture") -> None:
        """Взять буфер, собранный в другом потоке (`load` большого файла)."""
        self._ts, self._ch, self._flags, self._dlc, self._id = other._ts, other._ch, other._flags, other._dlc, other._id
        self._data, self._long, self.t0 = other._data, other._long, other.t0
        self.markers, self.meta, self.started_at = other.markers, other.meta, other.started_at
        self.full, self.recording = other.full, False
        self.loaded, self.dirty = other.loaded, other.dirty

    def duration_s(self) -> float:
        return self._ts[-1] - self._ts[0] if len(self) else 0.0


def marker_view(ms: list[Marker]) -> dict[str, str]:
    """Несколько меток на одном кадре показываем одной строкой."""
    return {"label": " · ".join(m.label for m in ms if m.label),
            "comment": " · ".join(m.comment for m in ms if m.comment)}
