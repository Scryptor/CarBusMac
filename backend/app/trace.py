"""Трейсы в формате JSON Lines: одна строка на кадр. Тайминги берутся из кадра
(метка прибора или arrival), при воспроизведении межкадровая пауза = разница
timestamp, делённая на speed. `to_monitor` реализует сервер (BE-5), выбирая
callback `send`; сам плеер лишь зовёт переданный `send` для каждого кадра."""
from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable

from app.models import CanFrame


class TraceWriter:
    def __init__(self, path: str) -> None:
        self._f = open(path, "w", encoding="utf-8")

    def write(self, frame: CanFrame, direction: str = "rx") -> None:
        rec = {
            "ts": frame.timestamp,
            "ts_source": frame.ts_source,
            "ch": frame.channel,
            "id": frame.can_id,
            "ext": frame.extended,
            "dlc": len(frame.data),
            "data": frame.data.hex(),
            "dir": direction,
        }
        self._f.write(json.dumps(rec) + "\n")

    def close(self) -> None:
        self._f.close()


class TraceReader:
    def __init__(self, path: str) -> None:
        self._path = path

    def frames(self) -> list[CanFrame]:
        out: list[CanFrame] = []
        with open(self._path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                out.append(
                    CanFrame(
                        channel=r["ch"],
                        can_id=r["id"],
                        data=bytes.fromhex(r["data"]),
                        extended=r.get("ext", False),
                        timestamp=r.get("ts", 0.0),
                        ts_source=r.get("ts_source", "device"),
                    )
                )
        return out


class TracePlayer:
    def __init__(self, frames: list[CanFrame]) -> None:
        self._frames = frames
        self._i = 0

    def step(self) -> CanFrame | None:
        if self._i >= len(self._frames):
            return None
        f = self._frames[self._i]
        self._i += 1
        return f

    async def play(
        self,
        send: Callable[[CanFrame], Awaitable[None]],
        *,
        speed: float = 1.0,
        repeat: bool = False,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        while True:
            prev_ts: float | None = None
            for frame in self._frames:
                if prev_ts is not None:
                    delay = (frame.timestamp - prev_ts) / speed
                    if delay > 0:
                        await sleep(delay)
                prev_ts = frame.timestamp
                await send(frame)
            if not repeat:
                return
