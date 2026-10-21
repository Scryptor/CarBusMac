"""Шкала времени: метка прибора → время хоста (общая шкала для Rx и Tx)."""
import pytest

from app.devclock import WRAP_S, DeviceClock

MIN = 60.0


def test_device_spacing_kept_and_never_later_than_arrival():
    c = DeviceClock()
    # кадры на шине через 1 мс, задержка доставки скачет 3 / 1 / 2 / 1 мс
    lat = [0.003, 0.001, 0.002, 0.001]
    out = []
    for k, delay in enumerate(lat):
        d = 10.0 + k * 0.001
        h = 500.0 + d + delay
        ts = c.to_host(int(d * 1e6), h)
        assert ts <= h + 1e-9
        out.append(ts)
    # после того как найдена минимальная задержка, промежутки — по меткам прибора
    assert out[3] - out[1] == pytest.approx(0.002, abs=1e-6)
    assert out[3] == pytest.approx(500.0 + 10.003 + 0.001, abs=1e-6)


def test_counter_wrap_is_unwrapped():
    c = DeviceClock()
    a = c.to_host(0xFFFF_FF00, 100.0)
    b = c.to_host(0x0000_0100, 100.000512)
    assert b - a == pytest.approx(512e-6, abs=1e-6)


@pytest.mark.parametrize("silence_min", [5, 40, 80, 150])
def test_long_silence_keeps_wall_time(silence_min):
    """Пауза в шине длиннее половины периода переполнения (35,8 мин) не путает развёртку."""
    c = DeviceClock()
    start_raw = int(66.7 * MIN * 1e6)            # счётчик прибора перед паузой: 66,7 мин
    a = c.to_host(start_raw, 1000.0)
    raw = (start_raw + int(silence_min * MIN * 1e6)) & 0xFFFFFFFF
    b = c.to_host(raw, 1000.0 + silence_min * MIN)
    assert b - a == pytest.approx(silence_min * MIN, abs=0.01)


def test_small_reordering_is_not_a_wrap():
    c = DeviceClock()
    a = c.to_host(5_000_000, 200.0)
    b = c.to_host(4_999_000, 200.0005)            # кадр с меткой на 1 мс раньше прошлого
    assert abs(b - a) < 0.01


def test_slow_device_crystal_is_followed():
    """Кварц прибора отстаёт на 100 ppm: время по-прежнему не уходит вперёд хоста
    и не отстаёт от него больше чем на задержку доставки."""
    c = DeviceClock()
    for k in range(0, 3601, 10):                  # час, кадр раз в 10 с
        h = 50.0 + k + 0.001
        d = k * (1 - 100e-6)
        ts = c.to_host(int(d * 1e6) & 0xFFFFFFFF, h)
        assert ts <= h + 1e-9
    assert h - ts < 0.01


def test_wrap_constant():
    assert WRAP_S == pytest.approx(4294.967296)


def test_delayed_first_frame_after_long_silence_does_not_send_time_back():
    c = DeviceClock()
    for k in range(50):                               # шина работает, задержка 1 мс
        d = k * 0.01
        c.to_host(int(d * 1e6), 100.0 + d + 0.001)
    out = []
    for k, delay in enumerate([0.048, 0.001, 0.001]):  # 10 мин тишины; первый кадр задержан на 48 мс
        d = 600.0 + k * 0.0005
        out.append(c.to_host(int(d * 1e6) & 0xFFFFFFFF, 100.0 + d + delay))
    assert out == sorted(out)                          # время не идёт назад
    assert out[2] - out[1] == pytest.approx(0.0005, abs=1e-6)


def test_clock_discontinuity_is_reanchored():
    """Сон компьютера или перезапуск прибора без обрыва связи: шкала не уезжает на десятки минут."""
    c = DeviceClock()
    c.to_host(5_000_000, 100.0)
    ts = c.to_host(1_000, 100.0 + 50 * 60)             # счётчик прибора начался заново
    assert abs(ts - (100.0 + 50 * 60)) < 1.0
