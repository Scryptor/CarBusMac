"""Поиск USB-портов и распознавание CAN-Hacker по USB-описателям — без открытия портов.

Общий код моста (`python -m app.bridge`, нативно на маке) и бэкенда (USB, проброшенный в
контейнер на Linux, или бэкенд без Docker). Порты только перечисляются: ни одного байта в
порт не уходит — открывает мост лишь то, что распознано как CAN-Hacker (или задано явно).

CAN-Hacker v3.2 на маке выглядит так (pyserial `list_ports`):
    /dev/cu.usbmodem00000000001A1  VID:PID 0483:5740  manufacturer «Spectratek»
    product «CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201»
то есть модель, серийный номер прибора (hex, 0x1B26 = 6950 — то же, что в «Информации об
устройстве»), версия прошивки. 0483:5740 — общий VID:PID «виртуального COM-порта» STM32;
по нему ищет приборы и десктоп, но его же носят чужие платы, поэтому без имени CAN-Hacker
такой порт помечается лишь как «compatible».

Только стандартная библиотека и pyserial: модуль запускается в окружении моста (Python 3.9+)."""
from __future__ import annotations

import os
import re
from typing import Any

CANHACKER_VID_PID = (0x0483, 0x5740)
_NAME_RE = re.compile(r"can[\s_-]?hacker", re.IGNORECASE)
# «CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201» → модель, серийный (hex), прошивка
_PRODUCT_RE = re.compile(
    r"^(?P<title>.*?\bv\d+(?:\.\d+)*)\s+(?P<serial>[0-9A-Fa-f]{4,16})\s+(?P<fw>\d+(?:\.\d+){1,3})\b")
KIND_ORDER = {"canhacker": 0, "compatible": 1, "other": 2}
_BARE_USB_RE = re.compile(r"^tty(ACM|USB)\d+$")


def _text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s.lower() != "n/a" else None


def classify(product: str | None, manufacturer: str | None, description: str | None,
             vid: int | None, pid: int | None) -> str:
    names = " ".join(x for x in (product, description, manufacturer) if x)
    if _NAME_RE.search(names) or (manufacturer or "").strip().lower() == "spectratek":
        return "canhacker"
    if (vid, pid) == CANHACKER_VID_PID:
        return "compatible"
    return "other"


def describe(device: str, *, product: Any = None, manufacturer: Any = None, description: Any = None,
             vid: int | None = None, pid: int | None = None, serial_number: Any = None) -> dict[str, Any]:
    """Описание порта для списка приборов (ключи — см. DeviceEntry в docs/architecture.md)."""
    product, manufacturer, description = _text(product), _text(manufacturer), _text(description)
    kind = classify(product, manufacturer, description, vid, pid)
    title, serial, firmware = product or description or os.path.basename(device), None, None
    m = _PRODUCT_RE.match(product or "")
    if m and kind != "other":
        title, serial, firmware = m["title"], int(m["serial"], 16), m["fw"]
    return {"path": device, "kind": kind, "title": title, "serial": serial, "firmware": firmware,
            "manufacturer": manufacturer, "product": product, "usb_serial": _text(serial_number),
            "vid": vid, "pid": pid}


def scan_ports(passthrough: bool = False) -> list[dict[str, Any]]:
    """USB-порты системы (порты без USB — Bluetooth, debug-console — пропускаются):
    сначала CAN-Hacker, потом совместимые по VID:PID, потом прочие.

    passthrough — бэкенд в контейнере: там есть только порты, проброшенные в compose
    (docker-compose.usb.yml), а USB-описатели pyserial берёт из /sys хоста — их может не
    оказаться. Такой ttyACM*/ttyUSB* без описателей всё равно предлагается как совместимый."""
    from serial.tools import list_ports

    out = []
    for p in list_ports.comports():
        if p.vid is None:
            if passthrough and _BARE_USB_RE.match(os.path.basename(p.device)):
                out.append({**describe(p.device), "kind": "compatible",
                            "title": f"USB-порт {os.path.basename(p.device)}"})
            continue
        out.append(describe(p.device, product=p.product, manufacturer=p.manufacturer,
                            description=p.description, vid=p.vid, pid=p.pid, serial_number=p.serial_number))
    out.sort(key=lambda d: (KIND_ORDER[d["kind"]], d["path"]))
    return out


def label(d: dict[str, Any]) -> str:
    """«CAN-Hacker v3.2 № 6950 (/dev/cu.usbmodem…)» — для сообщений моста и ошибок."""
    parts = [d.get("title") or d.get("path") or "?"]
    if d.get("serial") is not None:
        parts.append(f"№ {d['serial']}")
    return f"{' '.join(parts)} ({d.get('path')})"
