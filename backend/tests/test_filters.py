import pytest

from app.filters import (HwFilters, HwSlot, RangeExclusion, RangeFilter, SoftFilters,
                         layout_from_device, range_from_dict, slot_from_dict)
from app.models import CanFrame


def test_accept_without_ranges_passes_all():
    assert SoftFilters().accept(CanFrame(1, 0x123))


def test_range_with_exclusion_by_mask():
    sf = SoftFilters()
    sf.upsert(RangeFilter("r1", 1, True, 0x100, 0x1FF, [RangeExclusion(True, 0x120, 0x7F0)]))
    assert not sf.accept(CanFrame(1, 0x125))   # 0x125 & 0x7F0 == 0x120 → исключён
    assert sf.accept(CanFrame(1, 0x130))
    assert not sf.accept(CanFrame(1, 0x200))   # вне диапазона
    assert sf.accept(CanFrame(2, 0x200))       # у канала 2 диапазонов нет


def test_disabled_range_and_disabled_exclusion_ignored():
    sf = SoftFilters()
    sf.upsert(RangeFilter("r1", 1, False, 0x100, 0x1FF))
    assert sf.accept(CanFrame(1, 0x700))
    sf.upsert(RangeFilter("r1", 1, True, 0x100, 0x1FF, [RangeExclusion(False, 0x120, 0x7FF)]))
    assert sf.accept(CanFrame(1, 0x120))


def test_any_of_several_ranges_accepts():
    sf = SoftFilters()
    sf.upsert(RangeFilter("a", 1, True, 0x100, 0x10F))
    sf.upsert(RangeFilter("b", 1, True, 0x700, 0x7FF))
    assert sf.accept(CanFrame(1, 0x7E8)) and not sf.accept(CanFrame(1, 0x200))
    sf.delete("b")
    assert not sf.accept(CanFrame(1, 0x7E8))


def test_layout_from_device_info():
    info = {"filters_info": [{"channel": 1, "size": 13}, {"channel": 2, "size": 16}]}
    assert layout_from_device(info) == {1: 13, 2: 16}
    assert layout_from_device({}) == {1: 14, 2: 14}


def test_hw_slots_first_free_and_roundtrip():
    hw = HwFilters({1: 2, 2: 1})
    assert len(hw.slots) == 3
    hw.set(HwSlot(1, 0, True, 0x7E0, 0x7FF))
    assert hw.first_free(1).index == 1
    hw.set(HwSlot(1, 1, True, 0x7E8, 0x7FF))
    assert hw.first_free(1) is None
    again = HwFilters({1: 2, 2: 1})
    again.load_list(hw.to_list())
    assert again.slots == hw.slots


def test_hw_set_rejects_unknown_slot():
    with pytest.raises(ValueError):
        HwFilters({1: 2}).set(HwSlot(1, 5))


def test_slot_and_range_from_dict_validate():
    assert slot_from_dict({"channel": 1, "index": 0, "enabled": True, "can_id": 0x1F, "mask": 0x7FF,
                           "ext": False}) == HwSlot(1, 0, True, 0x1F, 0x7FF, False)
    with pytest.raises(ValueError):
        slot_from_dict({"channel": 1, "index": 0, "can_id": 0x800, "mask": 0x7FF, "ext": False})
    r = range_from_dict({"id": "r", "channel": 2, "start": 0x200, "end": 0x100,
                         "exclusions": [{"can_id": 0x150}]})
    assert (r.start, r.end) == (0x100, 0x200)             # перевёрнутый диапазон нормализуется
    assert r.exclusions[0] == RangeExclusion(True, 0x150, 0x7FF)
