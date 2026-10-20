"""Модели WS/REST (pydantic) и сериализаторы. Имена полей зеркалят frontend/src/ws.ts."""
from __future__ import annotations

from pydantic import BaseModel

from app.models import CanFrame
from app.monitor import MonitorRow


class FrameMsg(BaseModel):
    channel: int = 1
    can_id: int
    data: str = ""          # hex без разделителей, напр. "023e00"
    extended: bool = False
    rtr: bool = False
    fd: bool = False
    brs: bool = False

    def to_frame(self) -> CanFrame:
        return CanFrame(
            channel=self.channel,
            can_id=self.can_id,
            data=bytes.fromhex(self.data),
            extended=self.extended,
            rtr=self.rtr,
            fd=self.fd,
            brs=self.brs,
        )

    @classmethod
    def from_frame(cls, f: CanFrame) -> "FrameMsg":
        return cls(
            channel=f.channel,
            can_id=f.can_id,
            data=f.data.hex(),
            extended=f.extended,
            rtr=f.rtr,
            fd=f.fd,
            brs=f.brs,
        )


def row_to_dict(r: MonitorRow) -> dict:
    return {
        "ch": r.channel,
        "id": r.can_id,
        "ext": r.extended,
        "rtr": r.rtr,
        "fd": r.fd,
        "brs": r.brs,
        "dlc": r.dlc,
        "data": r.data.hex(),
        "count": r.count,
        "period_ms": r.period_ms,
        "changed": r.changed_mask,
        "stable_ms": r.stable_ms,
        "fc": r.fc,
        "ts": r.last_ts,
    }


def frame_to_dict(f: CanFrame, direction: str = "rx") -> dict:
    return {
        "ch": f.channel,
        "id": f.can_id,
        "ext": f.extended,
        "dlc": len(f.data),
        "data": f.data.hex(),
        "dir": direction,
        "ts": f.timestamp,
        "ts_source": f.ts_source,
    }
