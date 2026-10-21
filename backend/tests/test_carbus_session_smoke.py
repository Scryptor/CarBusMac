import os

import pytest

from app.carbus_session import CarbusSession

pytestmark = pytest.mark.skipif(
    not os.environ.get("CARBUS_BRIDGE"),
    reason="set CARBUS_BRIDGE=host:port (running ./run-bridge.sh) to run",
)


async def test_real_device_info():
    host, port = os.environ["CARBUS_BRIDGE"].split(":")
    s = CarbusSession(host, int(port))
    await s.connect()
    try:
        info = await s.get_device_info()
    finally:
        await s.close()
    assert info["hardware_name"]            # напр. HW_CH32
    assert info["firmware_version"]
