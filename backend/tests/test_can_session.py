import pytest

from app.models import CanFrame
from app.can_session import CanSession, FakeSession


async def test_fake_session_push_and_send():
    s = FakeSession(info={"hardware_name": "HW_CH32"})
    await s.connect()
    await s.open_channel(1, 500_000, listen_only=True)
    s.push(CanFrame(channel=1, can_id=0x123, data=b"\x01\x02"))
    got = await anext(s.frames())
    assert got.can_id == 0x123 and got.data == b"\x01\x02"
    await s.send(CanFrame(channel=1, can_id=0x7E0, data=b"\x3e"))
    assert s.sent[-1].can_id == 0x7E0


async def test_fake_session_connect_can_fail():
    s = FakeSession(fail_connect=True)
    with pytest.raises(ConnectionError):
        await s.connect()


def test_fake_session_satisfies_cansession_protocol():
    assert isinstance(FakeSession(), CanSession)
