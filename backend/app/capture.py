"""Буфер потока (режим «Поток» десктопа): запись/пауза, очистка, метки, выдача
диапазонов строк для виртуальной таблицы фронта. Хранение колоночное (array +
bytearray по 8 байт на кадр), чтобы часы записи на загруженной шине не съедали
память объектами Python; payload длиннее 8 байт (CAN-FD) — в отдельном словаре."""
from __future__ import annotations

from array import array
from dataclasses import dataclass

from app.models import CanFrame

_EXT, _RTR, _FD, _BRS, _TX, _ARRIVAL = 1, 2, 4, 8, 16, 32


@dataclass
class Marker:
    index: int          # метка стоит перед кадром с этим индексом
    label: str
    comment: str
    auto: bool = False


class Capture:
    def __init__(self, limit: int = 5_000_000) -> None:
        self.limit = limit
        self.recording = False
        self.full = False
        self.markers: list[Marker] = []
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
        self.full = False

    def __len__(self) -> int:
        return len(self._ts)

    def append(self, f: CanFrame) -> bool:
        if not self.recording:
            return False
        if len(self) >= self.limit:
            self.full = True
            self.recording = False
            return False
        self._push(f)
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
    def frame(self, i: int) -> CanFrame:
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

    def frames(self) -> list[CanFrame]:
        return [self.frame(i) for i in range(len(self))]

    def rows(self, start: int, count: int) -> list[dict]:
        start = max(0, start)
        end = min(len(self), start + max(0, count))
        marks = {m.index: m for m in self.markers}
        t0 = self.t0 or 0.0
        out = []
        for i in range(start, end):
            f = self.frame(i)
            m = marks.get(i)
            out.append({
                "i": i,
                "t": round(f.timestamp - t0, 6),
                "ch": f.channel,
                "dir": f.direction,
                "id": f.can_id,
                "ext": f.extended,
                "rtr": f.rtr,
                "dlc": len(f.data) if not f.rtr else self._dlc[i],
                "data": f.data.hex(),
                "marker": {"label": m.label, "comment": m.comment} if m else None,
            })
        return out

    def add_marker(self, label: str, comment: str, auto: bool = False) -> Marker:
        m = Marker(len(self), label, comment, auto)
        self.markers.append(m)
        return m

    def load(self, frames: list[CanFrame], markers: list[Marker]) -> None:
        self.clear()
        for f in frames:
            self._push(f)
        self.markers = list(markers)

    def duration_s(self) -> float:
        return self._ts[-1] - self._ts[0] if len(self) else 0.0
