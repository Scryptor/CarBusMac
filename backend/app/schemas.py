"""Сериализация строк монитора для WS. Имена полей зеркалят frontend/src/core/types.ts."""
from __future__ import annotations

from app.monitor import MonitorRow


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
