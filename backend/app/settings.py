"""Настройки приложения (аналог «Настройки приложения» десктопа). Значения по
умолчанию и диапазоны — из DFM-форм (TDLGAPPSETTINGS, TDLGRAREPERIOD)."""
from __future__ import annotations

import copy
from typing import Any

DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "system",
    "grid_font": "SF Mono",
    "grid_font_size": 13,
    "mark_changed": True,
    "mark_color": "#e0a526",
    "mark_hold_ms": 2000,
    "aggregator": False,
    "rare_mode": False,
    "rare_period_ms": 10000,
    "monitor_hex_ids": True,
    "monitor_sort": False,
    "monitor_group_by_channel": False,
    "restore_tx_on_start": True,
    "tracer_max_1s": False,
    "copy_header": True,
    "copy_id_hex": True,
    "copy_data_hex": True,
    "filter_new_active": True,
    "filter_restore_on_start": True,
    "filter_simple_mode": False,
    "log_autostart": False,
    "log_record_tx": True,
    "log_name_mask": "%Y-%m-%d_%H-%M-%S",
    "log_meta": {"transport": "", "brand": "", "model": "", "body": "", "year": ""},
}

RANGES: dict[str, tuple[int, int]] = {
    "grid_font_size": (11, 18),
    "mark_hold_ms": (500, 10000),
    "rare_period_ms": (100, 10000),
}

CHOICES: dict[str, tuple[str, ...]] = {
    "theme": ("system", "light", "dark"),
}


def _coerce(key: str, default: Any, value: Any) -> Any:
    if isinstance(default, bool):
        return bool(value)
    if isinstance(default, int):
        v = int(value)
        lo, hi = RANGES.get(key, (v, v))
        return min(max(v, lo), hi)
    if isinstance(default, dict):
        if not isinstance(value, dict):
            raise ValueError(key)
        out = dict(default)
        for k, v in value.items():
            if k in default:
                out[k] = str(v)
        return out
    v = str(value)
    if key in CHOICES and v not in CHOICES[key]:
        raise ValueError(key)
    return v


def merge_settings(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Накладывает patch на current: неизвестные ключи и невалидные значения
    отбрасываются, числа зажимаются в диапазоны, типы приводятся к типу дефолта."""
    out = copy.deepcopy(current)
    for key, value in patch.items():
        if key not in DEFAULT_SETTINGS:
            continue
        base = out.get(key, DEFAULT_SETTINGS[key])
        try:
            out[key] = _coerce(key, DEFAULT_SETTINGS[key] if not isinstance(base, dict) else base, value)
        except (TypeError, ValueError):
            continue
    return out
