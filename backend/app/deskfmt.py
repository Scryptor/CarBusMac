"""Файлы десктопной CarBUS Analyzer кроме трейсов: комментарии (.cmt) и список
передачи (.tsk). Формат сверен по реальным файлам пользователя и ключам из бинарника.

.cmt — строка на сообщение: `<ID 8 hex>=<комментарий>`, строки через CR, UTF-8.
.tsk — блоки `Task.Begin … Task.End` с ключами `Task.Message.*`, `Task.Delay` (период,
мс), `Task.Comment`, `Task.Trigger.*` (действие None/Single/Run/Stop, задержка, канал,
ID и данные как код/маска; пустое поле данных в UI = маска 00)."""
from __future__ import annotations

import re
from typing import Any

EOL = "\r"
_ACTIONS_IN = {"none": "none", "single": "single", "run": "start", "start": "start", "stop": "stop"}
_ACTIONS_OUT = {"none": "None", "single": "Single", "start": "Run", "stop": "Stop"}


# ------------------------------------------------------------------ .cmt ---
def parse_cmt(text: str) -> dict[str, str]:
    """Ключи результата — как у хаба: "<id>:<0|1>" (1 — 29-битный ID)."""
    out: dict[str, str] = {}
    for line in text.lstrip("﻿").splitlines():
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not re.fullmatch(r"[0-9A-Fa-f]{1,8}", key):
            continue
        raw = int(key, 16)
        can_id = raw & 0x1FFFFFFF
        ext = raw > 0x7FF
        value = re.sub(r"[\t\r\n\v\f]+", " ", value).strip()
        if value:
            out[f"{can_id}:{1 if ext else 0}"] = value
    return out


def format_cmt(comments: dict[str, str]) -> str:
    rows = []
    for key, text in comments.items():
        can_id, _, _ext = key.partition(":")
        rows.append((int(can_id), text.replace("\r", " ").replace("\n", " ")))
    rows.sort()
    return "".join(f"{can_id:08X}={text}{EOL}" for can_id, text in rows)


# ------------------------------------------------------------------ .tsk ---
def _bool(v: str) -> bool:
    return v.strip().lower() in ("true", "1", "yes")


def _hex_bytes(v: str, n: int) -> bytes:
    raw = bytes.fromhex(v.strip()) if v.strip() else b""
    return raw[:n].ljust(n, b"\x00")


def _task_from_block(d: dict[str, str], n: int) -> dict[str, Any] | None:
    proto = d.get("Task.Message.Proto", "CAN").strip().upper()
    if proto != "CAN":
        return None                          # LIN/FD-задачи этот этап не передаёт
    try:
        ext = _bool(d.get("Task.Message.ExtMsgID", "false"))
        can_id = int(d["Task.Message.MsgID"].strip(), 16)
        dlc = int(d.get("Task.Message.DLC", "0").strip() or 0)
        if not 0 <= dlc <= 8:
            raise ValueError("DLC вне 0..8")
        data = _hex_bytes(d.get("Task.Message.Data", ""), dlc)
        period = int(d.get("Task.Delay", "10").strip() or 10)
        action = _ACTIONS_IN.get(d.get("Task.Trigger.Trigger", "None").strip().lower(), "none")
        t_delay = int(d.get("Task.Trigger.Delay", "0").strip() or 0)
        t_ch_raw = d.get("Task.Trigger.Channel", "0").strip()
        t_ch = int(t_ch_raw) if t_ch_raw.isdigit() else 0
        mask_id = int(d.get("Task.Trigger.MaskMsgID", "0").strip() or "0", 16)
        code_id = int(d.get("Task.Trigger.CodeMsgID", "0").strip() or "0", 16)
        t_dlc_raw = d.get("Task.Trigger.DLC", "").strip()
        t_dlc = int(t_dlc_raw) if t_dlc_raw.lstrip("-").isdigit() and int(t_dlc_raw) >= 0 else None
        code_data = _hex_bytes(d.get("Task.Trigger.CodeData", ""), 8)
        mask_data = _hex_bytes(d.get("Task.Trigger.MaskData", ""), 8)
    except (KeyError, ValueError) as e:
        raise ValueError(f"Неверный формат файла задач (задача {n}): {e}") from None
    t_data = [code_data[i] if mask_data[i] else None for i in range(8)]
    return {
        "id": f"t{n}",
        "channel": int(d.get("Task.Message.Channel", "1").strip() or 1),
        "can_id": can_id,
        "ext": ext,
        "rtr": _bool(d.get("Task.Message.RTR", "false")),
        "data": data.hex(),
        "period_ms": min(max(period, 1), 10000),
        "comment": d.get("Task.Comment", "").strip(),
        "running": False,
        "count": 0,
        "trigger": {
            "action": action,
            "delay_ms": min(max(t_delay, 0), 10000),
            "channel": t_ch,
            "can_id": code_id if mask_id else None,
            # 29-битный ID может быть и ≤ 7FF: признак — маска шире 11 бит
            "ext": mask_id > 0x7FF or code_id > 0x7FF,
            "dlc": t_dlc,
            "data": t_data,
        },
    }


def parse_tsk(text: str) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    block: dict[str, str] | None = None
    n = 0
    for raw in text.lstrip("﻿").splitlines():
        line = raw.strip()
        if line == "Task.Begin":
            block = {}
        elif line == "Task.End":
            if block is not None:
                n += 1
                t = _task_from_block(block, n)
                if t is not None:
                    t["id"] = f"t{len(tasks) + 1}"
                    tasks.append(t)
            block = None
        elif block is not None and "=" in line:
            k, _, v = raw.partition("=")
            block[k.strip()] = v
    return tasks


def format_tsk(tasks: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for t in tasks:
        data = bytes.fromhex(t.get("data", ""))
        tr = t.get("trigger") or {}
        action = tr.get("action", "none")
        out += [
            "Task.Begin",
            "Task.Message.Proto=CAN",
            f"Task.Message.Channel={int(t.get('channel', 1))}",
            f"Task.Message.ExtMsgID={'true' if t.get('ext') else 'false'}",
            f"Task.Message.RTR={'true' if t.get('rtr') else 'false'}",
            f"Task.Message.MsgID={int(t.get('can_id', 0)):X}",
            f"Task.Message.DLC={len(data)}",
            f"Task.Message.Data={data.hex().upper()}",
            f"Task.Delay={int(t.get('period_ms', 10))}",
            f"Task.Comment={str(t.get('comment', '')).replace(chr(13), ' ').replace(chr(10), ' ')}",
            f"Task.Trigger.Trigger={_ACTIONS_OUT.get(action, 'None')}",
            f"Task.Trigger.Delay={int(tr.get('delay_ms', 0))}",
        ]
        if action != "none":
            t_id = tr.get("can_id")
            t_ext = bool(tr.get("ext"))
            code = bytes((b or 0) for b in (tr.get("data") or [None] * 8)[:8]).ljust(8, b"\x00")
            mask = bytes(0xFF if b is not None else 0 for b in (tr.get("data") or [None] * 8)[:8]).ljust(8, b"\x00")
            out += [
                f"Task.Trigger.Channel={int(tr.get('channel', 0))}",
                f"Task.Trigger.CodeMsgID={int(t_id or 0):X}",
                f"Task.Trigger.MaskMsgID={(0x1FFFFFFF if t_ext else 0x7FF) if t_id is not None else 0:X}",
                f"Task.Trigger.DLC={'' if tr.get('dlc') is None else int(tr['dlc'])}",
                f"Task.Trigger.CodeData={code.hex().upper()}",
                f"Task.Trigger.MaskData={mask.hex().upper()}",
            ]
        out += ["Task.End", ""]
    return EOL.join(out) + (EOL if out else "")
