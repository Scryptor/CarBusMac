"""Адаптер CanSession поверх carbus-lib — единственное место с настоящим железом.
Подключается к штатному TCP-мосту carbus-lib (open_tcp → pyserial socket://)."""
from __future__ import annotations

import time
from typing import AsyncIterator

from carbus_async import CanMessage, CarBusDevice

from app.models import CanFrame


class CarbusSession:
    def __init__(self, host: str, port: int) -> None:
        self._host = host
        self._port = port
        self._dev: CarBusDevice | None = None

    async def connect(self) -> None:
        self._dev = await CarBusDevice.open_tcp(self._host, self._port)

    async def close(self) -> None:
        if self._dev is not None:
            await self._dev.close()
            self._dev = None

    async def get_device_info(self) -> dict:
        info = await self._dev.get_device_info()
        return {
            "hardware_name": info.hardware_name,
            "hardware_id": info.hardware_id,
            "firmware_version": info.firmware_version,
            "serial_int": info.serial_int,
            "features_mask": info.features_mask,
            "feature_gateway": info.feature_gateway,
            "feature_isotp": info.feature_isotp,
            "feature_tx_buffer": info.feature_tx_buffer,
            "feature_tx_task": info.feature_tx_task,
            "channel_types": info.channel_types,
            "channel_features": info.channel_features,
            "channel_frequencies": info.channel_frequencies,
        }

    async def open_channel(self, channel: int, bitrate: int, listen_only: bool) -> None:
        await self._dev.open_can_channel(
            channel=channel, nominal_bitrate=bitrate, listen_only=listen_only
        )

    async def send(self, frame: CanFrame) -> None:
        msg = CanMessage(
            can_id=frame.can_id,
            data=frame.data,
            extended=frame.extended,
            rtr=frame.rtr,
            fd=frame.fd,
            brs=frame.brs,
        )
        await self._dev.send_can(msg, channel=frame.channel)

    async def set_hw_filter(
        self, channel: int, index: int, can_id: int, mask: int, extended: bool
    ) -> None:
        if extended:
            await self._dev.set_ext_id_filter(channel, index, can_id, mask)
        else:
            await self._dev.set_std_id_filter(channel, index, can_id, mask)

    async def clear_filters(self, channel: int) -> None:
        await self._dev.clear_all_filters(channel)

    async def frames(self) -> AsyncIterator[CanFrame]:
        while True:
            channel, msg = await self._dev.receive_can()
            if msg.timestamp_us:
                ts, src = msg.timestamp_us / 1_000_000.0, "device"
            else:
                ts, src = time.time(), "arrival"
            yield CanFrame(
                channel=channel,
                can_id=msg.can_id,
                data=bytes(msg.data),
                extended=msg.extended,
                rtr=msg.rtr,
                fd=msg.fd,
                brs=msg.brs,
                timestamp=ts,
                ts_source=src,
            )
