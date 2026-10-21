"""Демо-источник кадров: бэкенд целиком, но вместо прибора — генератор, похожий на
живую шину (меняющиеся байты, 29-битный ID, второй канал, ответ ЭБУ на запрос 0x7E0).
Нужен для разработки и проверки интерфейса без железа:

    python -m app.demo --port 8765 [--data DIR] [--traces DIR]
"""
from __future__ import annotations

import argparse
import asyncio
import random
import time
from pathlib import Path
from typing import AsyncIterator

from app.devclock import DeviceClock
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
    "channel_features": {1: {}, 2: {}},          # у CH32 программного терминатора нет
    "channel_frequencies": {1: 120_000_000, 2: 120_000_000},
    "filters_info": [{"channel": 1, "size": 14}, {"channel": 2, "size": 14}],
}


class DemoSession:
    """CanSession без железа: периодические кадры + ответ на диагностический запрос.

    Ведёт себя как прибор там, где это важно для логики бэкенда: метки времени — свободный
    32-битный счётчик мкс со случайным стартом (переводится в шкалу хоста тем же
    DeviceClock, что и у настоящей сессии), закрытый канал ничего не принимает и не
    передаёт, аппаратные фильтры отсеивают кадры, терминатора нет."""

    def __init__(self) -> None:
        self.connected = False
        self.open: set[int] = set()
        self.listen_only: set[int] = set()
        self._queue: asyncio.Queue[CanFrame] = asyncio.Queue()
        self._filters: dict[tuple[int, int], tuple[int, int, bool]] = {}
        self._clock = DeviceClock()
        self._t0 = time.monotonic()
        self._raw0 = random.randrange(2**32)

    def _now(self) -> float:
        """Время кадра «как от прибора»: метка счётчика → шкала хоста."""
        mono = time.monotonic()
        raw = (self._raw0 + int((mono - self._t0) * 1e6)) & 0xFFFFFFFF
        return self._clock.to_host(raw, mono)

    def _accepts(self, f: CanFrame) -> bool:
        if f.channel not in self.open:
            return False
        flt = [v for (ch, _), v in self._filters.items() if ch == f.channel]
        return not flt or any(ext == f.extended and (f.can_id & mask) == (cid & mask) for cid, mask, ext in flt)

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    async def get_device_info(self) -> dict:
        return dict(DEMO_INFO)

    async def open_channel(self, channel: int, bitrate: int | None, listen_only: bool,
                           timing: dict | None = None) -> None:
        self.open.add(channel)
        if listen_only:
            self.listen_only.add(channel)
        else:
            self.listen_only.discard(channel)

    async def set_terminator(self, channel: int, enabled: bool) -> None:
        raise RuntimeError("Device ERROR: терминатора нет")

    async def set_hw_filter(self, channel: int, index: int, can_id: int, mask: int, extended: bool) -> None:
        self._filters[(channel, index)] = (can_id, mask, extended)

    async def clear_hw_filter(self, channel: int, index: int) -> None:
        self._filters.pop((channel, index), None)

    async def clear_filters(self, channel: int) -> None:
        self._filters = {k: v for k, v in self._filters.items() if k[0] != channel}

    async def send(self, frame: CanFrame) -> None:
        if frame.channel not in self.open or frame.channel in self.listen_only:
            return                                            # прибор молча отбрасывает
        if frame.can_id == 0x7E0 and not frame.extended:     # «ЭБУ» отвечает на запрос
            await asyncio.sleep(0.005)
            sid = frame.data[1] if len(frame.data) > 1 else 0
            self._queue.put_nowait(CanFrame(frame.channel, 0x7E8, bytes([0x02, (sid + 0x40) & 0xFF, 0x00]),
                                            timestamp=self._now()))

    def _bus(self, n: int, ts: float) -> list[CanFrame]:
        out = []
        if n % 5 == 0:   # 0x120 каждые 50 мс: счётчик, редко меняющийся байт, константа
            out.append(CanFrame(1, 0x120, bytes([n // 5 & 0xFF, 0x00, 0x62 if (n // 300) % 2 else 0x22, 0xAA]),
                                timestamp=ts))
        if n % 10 == 0:  # 0x200 каждые 100 мс
            out.append(CanFrame(1, 0x200, bytes([0x10, 0x20, 0x30, (n * 7) & 0xFF, 0, 0, 0, 0x01]), timestamp=ts))
        if n % 100 == 0:
            out.append(CanFrame(1, 0x18DAF110, b"\x02\x7e\x00", extended=True, timestamp=ts))
        if n % 50 == 0:
            out.append(CanFrame(1, 0x3B0, b"OPEL-ASTRA"[: 8], timestamp=ts))
        if n % 20 == 0:
            out.append(CanFrame(2, 0x3FB, bytes([0x0C, (n // 20) & 0x0F, 0xFF, 0x00, 0x55]), timestamp=ts))
        return out

    async def frames(self) -> AsyncIterator[CanFrame]:
        n = 0
        while self.connected:
            await asyncio.sleep(0.01)
            n += 1
            while not self._queue.empty():
                f = self._queue.get_nowait()
                if self._accepts(f):
                    yield f
            for f in self._bus(n, self._now()):
                if self._accepts(f):
                    yield f


async def demo_discover(cfg: dict) -> dict:
    """Список приборов демо-сервера: один ненастоящий CAN-Hacker, мост не используется."""
    from app.devices import empty_snapshot, entry

    snap = empty_snapshot(cfg, "off")
    snap["devices"] = [entry("demo", {
        "path": "CAN-Hacker", "kind": "canhacker", "title": "CAN-Hacker v3.2", "serial": DEMO_INFO["serial_int"],
        "firmware": DEMO_INFO["firmware_version"], "manufacturer": "Spectratek",
        "product": "CAN-Hacker v3.2 (демо)", "vid": 0x0483, "pid": 0x5740})]
    return snap


def main() -> None:
    import uvicorn

    from app.server import create_app

    ap = argparse.ArgumentParser(description="CarBUS for Mac — демо без прибора")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", type=Path, default=None)
    ap.add_argument("--traces", type=Path, default=None)
    args = ap.parse_args()
    app = create_app(lambda cfg=None, device=None: DemoSession(), data_dir=args.data, traces_dir=args.traces,
                     discover=demo_discover)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
