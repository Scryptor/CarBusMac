"""Чистые данные доменной модели CAN (без зависимостей от транспорта)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CanFrame:
    """Один CAN-кадр. `timestamp` — секунды; `ts_source` = 'device' (метка прибора)
    или 'arrival' (время получения на хосте, когда прибор метку не дал)."""

    channel: int
    can_id: int
    data: bytes = b""
    extended: bool = False
    rtr: bool = False
    fd: bool = False
    brs: bool = False
    timestamp: float = 0.0
    ts_source: str = "device"
    direction: str = "rx"   # "rx" — принят из шины, "tx" — отправлен нами

    @property
    def dlc(self) -> int:
        return len(self.data)
