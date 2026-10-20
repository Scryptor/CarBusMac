"""Демо-источник кадров: бэкенд целиком, но вместо прибора — генератор, похожий на
живую шину (меняющиеся байты, 29-битный ID, второй канал, ответ ЭБУ на запрос 0x7E0).
Нужен для разработки и проверки интерфейса без железа:

    python -m app.demo --port 8765 [--data DIR] [--traces DIR]
"""
from __future__ import annotations

import argparse
import asyncio
import time
from pathlib import Path
from typing import AsyncIterator

from app.models import CanFrame

DEMO_INFO = {
    "hardware_name": "HW_CH32 (DEMO)",
    "hardware_id": 0x32,
    "firmware_version": "2.2.3.57",
    "serial_int": 6950,
    "features_mask": 0x7,
    "feature_gateway": True,
    "feature_isotp": True,
    "feature_tx_buffer": True,
    "feature_tx_task": True,
    "channel_types": {1: "CAN", 2: "CAN", 3: "LIN"},
    "channel_features": {1: {"terminator": True}, 2: {"terminator": True}},
    "channel_frequencies": {1: 120_000_000, 2: 120_000_000},
    "filters_info": [{"channel": 1, "size": 14}, {"channel": 2, "size": 14}],
}


class DemoSession:
    """CanSession без железа: периодические кадры + ответ на диагностический запрос."""

    def __init__(self) -> None:
        self.connected = False
        self.open: set[int] = set()
        self._queue: asyncio.Queue[CanFrame] = asyncio.Queue()
        self._t0 = time.monotonic()

    def _now(self) -> float:
        return time.monotonic() - self._t0

    async def connect(self) -> None:
        self.connected = True
        self._t0 = time.monotonic()

    async def close(self) -> None:
        self.connected = False

    async def get_device_info(self) -> dict:
        return dict(DEMO_INFO)

    async def open_channel(self, channel: int, bitrate: int | None, listen_only: bool,
                           timing: dict | None = None) -> None:
        self.open.add(channel)

    async def set_terminator(self, channel: int, enabled: bool) -> None:
        return None

    async def set_hw_filter(self, channel: int, index: int, can_id: int, mask: int, extended: bool) -> None:
        return None

    async def clear_hw_filter(self, channel: int, index: int) -> None:
        return None

    async def clear_filters(self, channel: int) -> None:
        return None

    async def send(self, frame: CanFrame) -> None:
        if frame.can_id == 0x7E0 and not frame.extended:     # «ЭБУ» отвечает на запрос
            await asyncio.sleep(0.005)
            sid = frame.data[1] if len(frame.data) > 1 else 0
            self._queue.put_nowait(CanFrame(frame.channel, 0x7E8, bytes([0x02, (sid + 0x40) & 0xFF, 0x00]),
                                            timestamp=self._now()))

    async def frames(self) -> AsyncIterator[CanFrame]:
        n = 0
        while self.connected:
            await asyncio.sleep(0.01)
            n += 1
            ts = self._now()
            while not self._queue.empty():
                yield self._queue.get_nowait()
            if 1 in self.open:
                if n % 5 == 0:   # 0x120 каждые 50 мс: счётчик, редко меняющийся байт, константа
                    yield CanFrame(1, 0x120, bytes([n // 5 & 0xFF, 0x00, 0x62 if (n // 300) % 2 else 0x22, 0xAA]),
                                   timestamp=ts)
                if n % 10 == 0:  # 0x200 каждые 100 мс
                    yield CanFrame(1, 0x200, bytes([0x10, 0x20, 0x30, (n * 7) & 0xFF, 0, 0, 0, 0x01]), timestamp=ts)
                if n % 100 == 0:
                    yield CanFrame(1, 0x18DAF110, b"\x02\x7e\x00", extended=True, timestamp=ts)
                if n % 50 == 0:
                    yield CanFrame(1, 0x3B0, b"OPEL-ASTRA"[: 8], timestamp=ts)
            if 2 in self.open and n % 20 == 0:
                yield CanFrame(2, 0x3FB, bytes([0x0C, (n // 20) & 0x0F, 0xFF, 0x00, 0x55]), timestamp=ts)


def main() -> None:
    import uvicorn

    from app.server import create_app

    ap = argparse.ArgumentParser(description="CarBUS for Mac — демо без прибора")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", type=Path, default=None)
    ap.add_argument("--traces", type=Path, default=None)
    args = ap.parse_args()
    app = create_app(lambda host=None, port=None: DemoSession(), data_dir=args.data, traces_dir=args.traces)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
