"""Абстракция устройства CAN. Вся логика бэкенда работает через этот интерфейс,
поэтому тестируется на FakeSession без железа. Реальная реализация поверх
carbus-lib — в carbus_session.py (задача BE-6)."""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Protocol, runtime_checkable

from app.models import CanFrame


@runtime_checkable
class CanSession(Protocol):
    async def connect(self) -> None: ...
    async def close(self) -> None: ...
    async def get_device_info(self) -> dict: ...
    async def open_channel(
        self, channel: int, bitrate: int | None, listen_only: bool, timing: dict | None = None
    ) -> None: ...
    async def send(self, frame: CanFrame) -> None: ...
    async def set_hw_filter(
        self, channel: int, index: int, can_id: int, mask: int, extended: bool
    ) -> None: ...
    async def clear_hw_filter(self, channel: int, index: int) -> None: ...
    async def clear_filters(self, channel: int) -> None: ...
    async def set_terminator(self, channel: int, enabled: bool) -> None: ...
    def frames(self) -> AsyncIterator[CanFrame]: ...


class FakeSession:
    """Тестовая сессия: `push` кладёт принятый кадр в `frames()`, `sent` копит
    отправленные, `info` настраивается, `fail_connect` имитирует недоступный мост."""

    def __init__(
        self,
        info: dict | None = None,
        fail_connect: bool = False,
        raise_on_frames: Exception | None = None,
    ) -> None:
        self.info = info or {}
        self.fail_connect = fail_connect
        self.raise_on_frames = raise_on_frames
        self.sent: list[CanFrame] = []
        self.channels: list[tuple[int, int | None, bool]] = []
        self.timings: dict[int, dict] = {}
        self.terminators: dict[int, bool] = {}
        self.filters: list[tuple[int, int, int, int, bool]] = []
        self.cleared: list[tuple[int, int]] = []
        self.connected = False
        self._queue: asyncio.Queue[CanFrame] = asyncio.Queue()

    async def connect(self) -> None:
        if self.fail_connect:
            raise ConnectionError("fake bridge connect failure")
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    async def get_device_info(self) -> dict:
        return dict(self.info)

    async def open_channel(
        self, channel: int, bitrate: int | None, listen_only: bool, timing: dict | None = None
    ) -> None:
        self.channels.append((channel, bitrate, listen_only))
        if timing is not None:
            self.timings[channel] = dict(timing)

    async def send(self, frame: CanFrame) -> None:
        self.sent.append(frame)

    async def set_hw_filter(
        self, channel: int, index: int, can_id: int, mask: int, extended: bool
    ) -> None:
        self.filters.append((channel, index, can_id, mask, extended))

    async def clear_hw_filter(self, channel: int, index: int) -> None:
        self.filters = [f for f in self.filters if (f[0], f[1]) != (channel, index)]
        self.cleared.append((channel, index))

    async def clear_filters(self, channel: int) -> None:
        self.filters = [f for f in self.filters if f[0] != channel]

    async def set_terminator(self, channel: int, enabled: bool) -> None:
        self.terminators[channel] = enabled

    def push(self, frame: CanFrame) -> None:
        self._queue.put_nowait(frame)

    async def frames(self) -> AsyncIterator[CanFrame]:
        if self.raise_on_frames is not None:
            raise self.raise_on_frames
        while True:
            yield await self._queue.get()
