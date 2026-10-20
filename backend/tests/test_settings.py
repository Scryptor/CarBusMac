from app.settings import DEFAULT_SETTINGS, merge_settings


def test_merge_settings_clamps_and_ignores_unknown():
    s = merge_settings(DEFAULT_SETTINGS, {"mark_hold_ms": 50, "nope": 1, "grid_font_size": "40"})
    assert s["mark_hold_ms"] == 500
    assert s["grid_font_size"] == 18
    assert "nope" not in s


def test_merge_settings_keeps_types_and_does_not_mutate_input():
    before = dict(DEFAULT_SETTINGS)
    s = merge_settings(DEFAULT_SETTINGS, {"aggregator": 1, "theme": "dark", "rare_period_ms": 20000})
    assert s["aggregator"] is True
    assert s["theme"] == "dark"
    assert s["rare_period_ms"] == 10000
    assert DEFAULT_SETTINGS == before


def test_merge_settings_rejects_bad_theme_and_merges_nested_meta():
    s = merge_settings(DEFAULT_SETTINGS, {"theme": "neon", "log_meta": {"brand": "Lada", "x": 1}})
    assert s["theme"] == "system"
    assert s["log_meta"]["brand"] == "Lada"
    assert "x" not in s["log_meta"]
    assert s["log_meta"]["model"] == ""


def test_defaults_match_desktop_values():
    assert DEFAULT_SETTINGS["mark_hold_ms"] == 2000
    assert DEFAULT_SETTINGS["rare_period_ms"] == 10000
    assert DEFAULT_SETTINGS["grid_font_size"] == 13
