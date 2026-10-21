"""Какие приборы видит бэкенд и к какому подключаться.

Пути к прибору: «bridge» — нативный мост на маке (app/bridge.py: Docker Desktop на macOS
USB в контейнер не пробрасывает), «usb» — порт виден самому бэкенду (Docker на Linux с
пробросом USB, docker-compose.usb.yml, или бэкенд без Docker), «demo» — демо-сервер.
`discover` собирает снимок (интерфейс получает его событием `devices`), `pick` выбирает
прибор для подключения: явно выбранный или единственный найденный CAN-Hacker."""
from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any

from app.bridge import BridgeDown, BridgeForeign, BridgeRefused, bridge_list
from app.usbports import KIND_ORDER, label, scan_ports

BRIDGE_TIMEOUT_S = 1.0     # мост локальный: дольше молчит — значит, не он

Snapshot = dict[str, Any]


class DeviceError(Exception):
    """Не к чему подключаться — текст для пользователя."""


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) and v else None


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def entry(source: str, port: dict[str, Any]) -> dict[str, Any]:
    """Прибор в списке интерфейса (DeviceEntry). Описание от моста приходит по сети —
    берём только известные поля нужных типов."""
    kind = port.get("kind") if port.get("kind") in KIND_ORDER else "other"
    path = str(port.get("path") or "")
    forced = bool(port.get("forced"))
    return {"key": f"{source}:{path}", "source": source, "path": path, "kind": kind,
            "title": _str(port.get("title")) or os.path.basename(path) or path,
            "serial": _int(port.get("serial")), "firmware": _str(port.get("firmware")),
            "manufacturer": _str(port.get("manufacturer")), "product": _str(port.get("product")),
            "usb_serial": _str(port.get("usb_serial")), "vid": _int(port.get("vid")), "pid": _int(port.get("pid")),
            "busy": bool(port.get("busy")), "forced": forced, "selectable": kind != "other" or forced}


def in_container() -> bool:
    return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")    # Docker / Podman


def empty_snapshot(cfg: dict[str, Any] | None = None, state: str = "unknown") -> Snapshot:
    address = f"{cfg['bridge_host']}:{cfg['bridge_port']}" if cfg else ""
    return {"devices": [], "bridge": {"state": state, "address": address, "message": ""},
            "usb": {"state": "ok", "in_container": in_container()}, "hint": ""}


def not_found_hint(snap: Snapshot) -> str:
    bridge = snap["bridge"]
    addr = bridge["address"]
    if bridge["state"] == "down":
        return f"Мост не запущен ({addr}). Запустите на маке ./run-bridge.sh — прибор появится здесь сам."
    if bridge["state"] == "foreign":
        return (f"Мост не отвечает: по адресу {addr} слушает другая программа (без моста порт 7000 на macOS "
                "занимает «Приёмник AirPlay»). Запустите на маке ./run-bridge.sh — прибор появится здесь сам.")
    if bridge["state"] == "ok":
        return "Мост работает, но CAN-Hacker не подключён по USB."
    if bridge["state"] == "unknown":
        return ""
    return "CAN-Hacker не найден на USB."


async def discover(cfg: dict[str, Any], *,
                   scan: Callable[[], list[dict[str, Any]]] | None = None,
                   listing: Callable[[str, int, float], Awaitable[list[dict[str, Any]]]] = bridge_list,
                   container: bool | None = None) -> Snapshot:
    """Снимок: свои USB-порты и порты моста (один и тот же прибор, видный обоими путями, —
    один раз, через USB напрямую)."""
    snap = empty_snapshot(cfg, "ok")
    if container is not None:
        snap["usb"]["in_container"] = container
    passthrough = snap["usb"]["in_container"]
    try:
        local = await asyncio.to_thread(scan or (lambda: scan_ports(passthrough)))
    except Exception:          # pyserial не перечислил порты — остаётся мост
        local = []
        snap["usb"]["state"] = "unavailable"
    devices = [entry("usb", p) for p in local if isinstance(p, dict)]
    seen = {(d["path"], d["usb_serial"], d["product"]) for d in devices}
    try:
        remote = await listing(cfg["bridge_host"], int(cfg["bridge_port"]), BRIDGE_TIMEOUT_S)
    except BridgeDown as e:
        remote = []
        snap["bridge"].update(state="down", message=str(e))
    except (BridgeForeign, BridgeRefused) as e:
        remote = []
        snap["bridge"].update(state="foreign", message=str(e))
    for p in remote:
        if isinstance(p, dict) and p.get("path"):
            d = entry("bridge", p)
            if (d["path"], d["usb_serial"], d["product"]) not in seen:
                devices.append(d)
    devices.sort(key=lambda d: (not d["selectable"], KIND_ORDER[d["kind"]], d["source"] != "usb", d["path"]))
    snap["devices"] = devices
    snap["hint"] = "" if any(d["selectable"] for d in devices) else not_found_hint(snap)
    return snap


def pick(snap: Snapshot, key: str) -> dict[str, Any]:
    """Прибор для подключения: по ключу из «Настроек устройства» или, если ключа нет
    (`""`), единственный найденный CAN-Hacker."""
    devices = snap.get("devices") or []
    ok = [d for d in devices if d["selectable"]]
    if key:
        for d in devices:
            if d["key"] == key:
                if not d["selectable"]:
                    raise DeviceError(f"{label(d)} — не CAN-Hacker, подключение к нему отключено.")
                return d
        path = key.partition(":")[2]
        same = [d for d in ok if d["path"] == path]
        if len(same) == 1:          # тот же порт, но другим путём (мост ↔ USB в контейнере)
            return same[0]
        hint = snap.get("hint") or "Подключите его по USB или выберите другой в «Настройках устройства»."
        raise DeviceError(f"Прибор {path or key} не найден. {hint}")
    cands = [d for d in ok if d["forced"]] or [d for d in ok if d["kind"] == "canhacker"] or ok
    if len(cands) == 1:
        return cands[0]
    if not cands:
        raise DeviceError(snap.get("hint") or "CAN-Hacker не найден.")
    raise DeviceError("Найдено несколько приборов — выберите нужный в «Настройках устройства».")
