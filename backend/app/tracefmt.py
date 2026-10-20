"""Форматы файлов трейсов.

`.trc` — текстовый формат десктопной CarBUS Analyzer, версия 3 (восстановлен из
бинарника, см. спек §8):

    @ TEXT @ 3 @ 64 @ 0 @ <кадров> @ <длительность мс> @ [<N>d ]hh:mm:ss.mmm @
    # $LocalTime=HH:MM:SS.mmm
    ------<TAB>метка<TAB>комментарий
    СС,мкссс<TAB>CH<TAB>ФЛАГИ<TAB>ID<TAB>DLC<TAB>XX XX ..<TAB>00000000<TAB>ASCII<TAB>комментарий

Время в строке — секунды по модулю 60 и микросекунды; при чтении переход через
минуту разворачивается. Флаги: бит 0 — 29-битный ID, бит 1 — RTR, 0x4 — классический
CAN, 0x10 — CAN-FD, 0x100 — LIN (LIN-кадры пропускаются). Направление Rx/Tx в `.trc`
не кодируется (бит неизвестен) — для него есть наш `.jsonl`.

`.jsonl` — формат CarBUS for Mac: первая строка — заголовок {"format", "meta",
"markers"}, далее по строке на кадр. Читаются и старые файлы v1 без заголовка."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from app.capture import Marker
from app.models import CanFrame

TRC_SIGNATURE = "TEXT"
TRC_VERSION = 3
_MINUTE_US = 60_000_000
_F_EXT, _F_RTR, _F_CAN, _F_FD, _F_LIN = 0x1, 0x2, 0x4, 0x10, 0x100
EOL = "\r\n"


@dataclass
class TraceDoc:
    frames: list[CanFrame]
    markers: list[Marker] = field(default_factory=list)
    comments: dict[int, str] = field(default_factory=dict)
    meta: dict[str, str] = field(default_factory=dict)
    skipped: int = 0


# ---------------------------------------------------------------- .trc ---
def _bad_format() -> ValueError:
    return ValueError("Неверный формат файла!")


def _bad_line(n: int) -> ValueError:
    return ValueError(f"Неверный формат файла в строке {n}!")


def _parse_header(line: str) -> int:
    norm = re.sub(r" {2,}", " ", line)
    parts = norm.split("@")
    if len(parts) != 9 or parts[1].strip() != TRC_SIGNATURE:
        raise _bad_format()
    try:
        version = int(parts[2].strip())
    except ValueError:
        raise _bad_format() from None
    if version != TRC_VERSION:
        raise ValueError(f"Неподдерживаемая версия .trc: {version} (поддерживается {TRC_VERSION})")
    return version


def _parse_time_us(field_: str) -> int:
    sec, _, frac = field_.strip().partition(",")
    frac = (frac + "000000")[:6]
    return (int(sec) % 60) * 1_000_000 + int(frac)


def parse_trc(text: str) -> TraceDoc:
    lines = text.lstrip("﻿").splitlines()
    if not lines:
        raise _bad_format()
    _parse_header(lines[0])
    doc = TraceDoc(frames=[])
    prev_us: int | None = None
    offset_us = 0
    for n, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue
        if line.startswith("#"):
            key, sep, value = line[1:].strip().partition("=")
            if sep:
                doc.meta[key.strip()] = value.strip()
            continue
        fields = line.split("\t")
        if fields[0] == "------":
            label = fields[1] if len(fields) > 1 else ""
            comment = fields[2] if len(fields) > 2 else ""
            doc.markers.append(Marker(len(doc.frames), label, comment))
            continue
        if len(fields) == 8:
            fields.append("")
        if len(fields) != 9:
            raise _bad_line(n)
        try:
            t_us = _parse_time_us(fields[0])
            channel = int(fields[1])
            flags = int(fields[2], 16)
            can_id = int(fields[3], 16)
            dlc = int(fields[4])
            data = bytes.fromhex(fields[5].replace(" ", ""))
        except ValueError:
            raise _bad_line(n) from None
        if prev_us is not None and t_us < prev_us:
            offset_us += _MINUTE_US
        prev_us = t_us
        if flags & _F_LIN or not flags & (_F_CAN | _F_FD):
            doc.skipped += 1
            continue
        rtr = bool(flags & _F_RTR) and not flags & _F_FD
        if not rtr and len(data) != dlc:
            raise _bad_line(n)
        if fields[8]:
            doc.comments[len(doc.frames)] = fields[8]
        doc.frames.append(CanFrame(
            channel=channel,
            can_id=can_id,
            data=data,
            extended=bool(flags & _F_EXT),
            rtr=rtr,
            fd=bool(flags & _F_FD),
            timestamp=(offset_us + t_us) / 1e6,
        ))
    return doc


def _ascii(data: bytes) -> str:
    return "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in data)


def _fmt_duration(ms: int) -> str:
    days, rem = divmod(ms, 86_400_000)
    h, rem = divmod(rem, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    prefix = f"{days}d " if days else ""
    return f"{prefix}{h:02d}:{m:02d}:{s:02d}.{msec:03d}"


def format_trc(doc: TraceDoc, local_time: datetime | None = None) -> str:
    frames = doc.frames
    t_first = frames[0].timestamp if frames else 0.0
    dur_ms = round((frames[-1].timestamp - t_first) * 1000) if frames else 0
    out = [f"@ {TRC_SIGNATURE} @ {TRC_VERSION} @ 64 @ 0 @ {len(frames)} @ {dur_ms} @ {_fmt_duration(dur_ms)} @"]
    if local_time is not None and frames:
        out.append(f"# $LocalTime={local_time.strftime('%H:%M:%S')}.{local_time.microsecond // 1000:03d}")
    for k, v in doc.meta.items():
        if k != "$LocalTime" or local_time is None:
            out.append(f"# {k}={v}")
    marks: dict[int, list[Marker]] = {}
    for m in doc.markers:
        marks.setdefault(m.index, []).append(m)
    for i, f in enumerate(frames):
        for m in marks.get(i, []):
            out.append(f"------\t{m.label}\t{m.comment}")
        us = round((f.timestamp - t_first) * 1e6) % _MINUTE_US
        flags = (_F_FD if f.fd else _F_CAN) | (_F_EXT if f.extended else 0) | (_F_RTR if f.rtr else 0)
        can_id = f"{f.can_id:08X}" if f.extended else f"{f.can_id:03X}"
        data = " ".join(f"{b:02X}" for b in f.data)
        out.append(
            f"{us // 1_000_000:02d},{us % 1_000_000:06d}\t{f.channel}\t{flags:08x}\t{can_id}\t"
            f"{len(f.data)}\t{data:<23}\t00000000\t{_ascii(f.data)}\t{doc.comments.get(i, '')}"
        )
    for m in marks.get(len(frames), []):
        out.append(f"------\t{m.label}\t{m.comment}")
    return EOL.join(out) + EOL


# -------------------------------------------------------------- .jsonl ---
JSONL_FORMAT = "carbus-mac-jsonl"


def format_jsonl(doc: TraceDoc) -> str:
    head = {"format": JSONL_FORMAT, "version": 1, "meta": doc.meta,
            "markers": [{"index": m.index, "label": m.label, "comment": m.comment, "auto": m.auto}
                        for m in doc.markers]}
    lines = [json.dumps(head, ensure_ascii=False)]
    for i, f in enumerate(doc.frames):
        rec = {"ts": f.timestamp, "ts_source": f.ts_source, "ch": f.channel, "id": f.can_id,
               "ext": f.extended, "rtr": f.rtr, "fd": f.fd, "brs": f.brs, "dlc": len(f.data),
               "data": f.data.hex(), "dir": f.direction}
        if i in doc.comments:
            rec["comment"] = doc.comments[i]
        lines.append(json.dumps(rec, ensure_ascii=False))
    return "\n".join(lines) + "\n"


def parse_jsonl(text: str) -> TraceDoc:
    doc = TraceDoc(frames=[])
    for n, line in enumerate(text.lstrip("﻿").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            if "format" in r and "ts" not in r:
                doc.meta = {str(k): str(v) for k, v in r.get("meta", {}).items()}
                doc.markers = [Marker(int(m["index"]), str(m.get("label", "")), str(m.get("comment", "")),
                                      bool(m.get("auto", False))) for m in r.get("markers", [])]
                continue
            if r.get("comment"):
                doc.comments[len(doc.frames)] = str(r["comment"])
            doc.frames.append(CanFrame(
                channel=int(r["ch"]),
                can_id=int(r["id"]),
                data=bytes.fromhex(r.get("data", "")),
                extended=bool(r.get("ext", False)),
                rtr=bool(r.get("rtr", False)),
                fd=bool(r.get("fd", False)),
                brs=bool(r.get("brs", False)),
                timestamp=float(r.get("ts", 0.0)),
                ts_source=str(r.get("ts_source", "device")),
                direction=str(r.get("dir", "rx")),
            ))
        except (ValueError, KeyError, TypeError):
            raise _bad_line(n) from None
    return doc


# ---------------------------------------------------------------- файлы ---
def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1251")


def read_trace(path: Path) -> TraceDoc:
    suffix = Path(path).suffix.lower()
    if suffix == ".trc":
        return parse_trc(_decode(Path(path).read_bytes()))
    if suffix == ".jsonl":
        return parse_jsonl(_decode(Path(path).read_bytes()))
    raise ValueError("Не поддерживаемое расширение формата!")


def write_trace(path: Path, doc: TraceDoc, local_time: datetime | None = None) -> None:
    suffix = Path(path).suffix.lower()
    if suffix == ".trc":
        text = format_trc(doc, local_time)
    elif suffix == ".jsonl":
        text = format_jsonl(doc)
    else:
        raise ValueError("Не поддерживаемое расширение формата!")
    Path(path).write_text(text, encoding="utf-8", newline="")
