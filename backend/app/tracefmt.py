"""Форматы файлов трейсов.

`.trc` — текстовый формат десктопной CarBUS Analyzer, версия 3 (восстановлен из
бинарника, см. спек §8):

    @ TEXT @ 3 @ 64 @ 0 @ <кадров> @ <длительность мс> @ [<N>d ]hh:mm:ss.mmm @
    # $LocalTime=HH:MM:SS.mmm
    ------<TAB>метка<TAB>комментарий
    СС,мкссс<TAB>CH<TAB>ФЛАГИ<TAB>ID<TAB>DLC<TAB>XX XX ..<TAB>00000000<TAB>ASCII<TAB>комментарий

Время в строке — секунды по модулю 60 и микросекунды; при чтении переход через
минуту разворачивается, поэтому при записи время не может идти назад (кадр, пришедший
с меткой чуть раньше предыдущего, получает его время — иначе при чтении он «уехал» бы
на минуту вперёд). Комментарии и метки пишутся без табуляций и переводов строк.
У RTR-кадра данных нет, но DLC есть: в памяти такой кадр хранит DLC нулевых байт. Флаги: бит 0 — 29-битный ID, бит 1 — RTR, 0x4 — классический
CAN, 0x10 — CAN-FD, 0x100 — LIN (LIN-кадры пропускаются). Направление Rx/Tx в `.trc`
не кодируется (бит неизвестен) — для него есть наш `.jsonl`.

`.jsonl` — формат CarBUS for Mac: первая строка — заголовок {"format", "meta",
"markers"}, далее по строке на кадр (с паузами строки отладчика, если они заданы).
Читаются и старые файлы v1 без заголовка.

Запись потоковая (строки уходят в файл порциями), чтобы сохранение миллионов кадров не
держало весь текст в памяти; `frames` может быть ленивой последовательностью."""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator, Sequence

from app.capture import Marker
from app.models import CanFrame

TRC_SIGNATURE = "TEXT"
TRC_VERSION = 3
_MINUTE_US = 60_000_000
_F_EXT, _F_RTR, _F_CAN, _F_FD, _F_LIN = 0x1, 0x2, 0x4, 0x10, 0x100
EOL = "\r\n"


@dataclass
class TraceDoc:
    frames: Sequence[CanFrame]
    markers: list[Marker] = field(default_factory=list)
    comments: dict[int, str] = field(default_factory=dict)      # комментарий строки по её номеру
    meta: dict[str, str] = field(default_factory=dict)
    skipped: int = 0
    pauses: dict[int, tuple[int, int]] = field(default_factory=dict)   # строка → (до, после), мс
    # комментарии сообщений «<id>:<0|1>» — подставляются при записи строкам без своего
    id_comments: dict[str, str] = field(default_factory=dict)

    def comment(self, i: int, f: CanFrame) -> str:
        return self.comments.get(i) or self.id_comments.get(f"{f.can_id}:{1 if f.extended else 0}", "")


_LINES = re.compile(r"\r\n|\r|\n")
_BREAKS = re.compile(r"[\t\r\n\v\f\x1c-\x1e\x85\u2028\u2029]+")


def clean_text(text: str) -> str:
    """Текст для поля файла: табуляция и переводы строк ломают разбор строки."""
    return _BREAKS.sub(" ", str(text)).strip()


def _split_lines(text: str) -> list[str]:
    # str.splitlines() режет ещё и по \v, \f, \x1c-\x1e, \x85, \u2028 — их в тексте
    # комментария десктоп мог оставить; строки файла разделяет только CR/LF
    return _LINES.split(text.lstrip("\ufeff"))


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
    lines = _split_lines(text)
    if not lines or not lines[0].strip():
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
        fields = line.split("\t", 8)
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
        if rtr:
            if not 0 <= dlc <= 8:
                raise _bad_line(n)
            data = bytes(dlc)                    # данных у RTR нет, DLC — есть
        elif len(data) != dlc:
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
    """Как пишет десктоп: непечатные байты — пробелы, ширина не меньше 8."""
    return "".join(chr(b) if 0x20 <= b < 0x7F else " " for b in data).ljust(8)


def _fmt_duration(ms: int) -> str:
    days, rem = divmod(ms, 86_400_000)
    h, rem = divmod(rem, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    prefix = f"{days}d " if days else ""
    return f"{prefix}{h:02d}:{m:02d}:{s:02d}.{msec:03d}"


def trc_header(count: int, dur_ms: int, local_time: datetime | None, meta: dict[str, str]) -> list[str]:
    """Заголовок .trc: сигнатура с числом кадров и длительностью, `# $LocalTime`, метаинформация."""
    out = [f"@ {TRC_SIGNATURE} @ {TRC_VERSION} @ 64 @ 0 @ {count} @ {dur_ms} @ {_fmt_duration(dur_ms)} @"]
    if local_time is not None and count:
        out.append(f"# $LocalTime={local_time.strftime('%H:%M:%S')}.{local_time.microsecond // 1000:03d}")
    for k, v in meta.items():
        if k != "$LocalTime" or local_time is None:
            out.append(f"# {clean_text(k)}={clean_text(v)}")
    return out


def trc_frame_line(f: CanFrame, t_first: float, comment: str = "", ts: float | None = None) -> str:
    """Строка кадра; `ts` — время для записи, если оно отличается от метки кадра
    (неубывающее время, см. шапку модуля)."""
    us = round(((f.timestamp if ts is None else ts) - t_first) * 1e6) % _MINUTE_US
    flags = (_F_FD if f.fd else _F_CAN) | (_F_EXT if f.extended else 0) | (_F_RTR if f.rtr else 0)
    can_id = f"{f.can_id:08X}" if f.extended else f"{f.can_id:03X}"
    payload = b"" if f.rtr else f.data
    data = " ".join(f"{b:02X}" for b in payload)
    return (f"{us // 1_000_000:02d},{us % 1_000_000:06d}\t{f.channel}\t{flags:08x}\t{can_id}\t"
            f"{len(f.data)}\t{data:<23}\t00000000\t{_ascii(payload)}\t{clean_text(comment)}")


def _marker_line(m: Marker) -> str:
    return f"------\t{clean_text(m.label)}\t{clean_text(m.comment)}"


def iter_trc(doc: TraceDoc, local_time: datetime | None = None) -> Iterator[str]:
    frames = doc.frames
    n = len(frames)
    t_first = frames[0].timestamp if n else 0.0
    t_last = t_first
    for f in frames:                      # длительность — по неубывающему времени
        if f.timestamp > t_last:
            t_last = f.timestamp
    yield from trc_header(n, round((t_last - t_first) * 1000), local_time, doc.meta)
    marks: dict[int, list[Marker]] = {}
    for m in doc.markers:
        marks.setdefault(m.index, []).append(m)
    t = t_first
    for i, f in enumerate(frames):
        for m in marks.get(i, ()):
            yield _marker_line(m)
        if f.timestamp > t:
            t = f.timestamp
        yield trc_frame_line(f, t_first, doc.comment(i, f), ts=t)
    for m in marks.get(n, ()):
        yield _marker_line(m)


def format_trc(doc: TraceDoc, local_time: datetime | None = None) -> str:
    return EOL.join(iter_trc(doc, local_time)) + EOL


# -------------------------------------------------------------- .jsonl ---
JSONL_FORMAT = "carbus-mac-jsonl"


def iter_jsonl(doc: TraceDoc) -> Iterator[str]:
    head = {"format": JSONL_FORMAT, "version": 1, "meta": doc.meta,
            "markers": [{"index": m.index, "label": m.label, "comment": m.comment, "auto": m.auto}
                        for m in doc.markers]}
    yield json.dumps(head, ensure_ascii=False)
    for i, f in enumerate(doc.frames):
        rec = {"ts": f.timestamp, "ts_source": f.ts_source, "ch": f.channel, "id": f.can_id,
               "ext": f.extended, "rtr": f.rtr, "fd": f.fd, "brs": f.brs, "dlc": len(f.data),
               "data": "" if f.rtr else f.data.hex(), "dir": f.direction}
        comment = doc.comment(i, f)
        if comment:
            rec["comment"] = comment
        before, after = doc.pauses.get(i, (0, 0))
        if before:
            rec["before_ms"] = before
        if after:
            rec["after_ms"] = after
        yield json.dumps(rec, ensure_ascii=False)


def format_jsonl(doc: TraceDoc) -> str:
    return "\n".join(iter_jsonl(doc)) + "\n"


def _finite(v: float) -> float:
    if not math.isfinite(v):
        raise ValueError("не число")
    return v


def parse_jsonl(text: str) -> TraceDoc:
    doc = TraceDoc(frames=[])
    for n, line in enumerate(_split_lines(text), start=1):
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
            i = len(doc.frames)
            if r.get("comment"):
                doc.comments[i] = str(r["comment"])
            before, after = int(r.get("before_ms", 0)), int(r.get("after_ms", 0))
            if before or after:
                doc.pauses[i] = (max(0, before), max(0, after))
            rtr = bool(r.get("rtr", False))
            dlc = int(r.get("dlc", 0))
            if rtr and not 0 <= dlc <= 8:
                raise ValueError("DLC")
            doc.frames.append(CanFrame(
                channel=int(r["ch"]),
                can_id=int(r["id"]),
                data=bytes(dlc) if rtr else bytes.fromhex(r.get("data", "")),
                extended=bool(r.get("ext", False)),
                rtr=rtr,
                fd=bool(r.get("fd", False)),
                brs=bool(r.get("brs", False)),
                timestamp=_finite(float(r.get("ts", 0.0))),
                ts_source=str(r.get("ts_source", "device")),
                direction="tx" if r.get("dir") == "tx" else "rx",
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
    """Пишет во временный файл и переименовывает: оборванная запись не портит старый файл."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".trc":
        lines, eol = iter_trc(doc, local_time), EOL
    elif suffix == ".jsonl":
        lines, eol = iter_jsonl(doc), "\n"
    else:
        raise ValueError("Не поддерживаемое расширение формата!")
    with atomic_text(path) as fh:
        chunk: list[str] = []
        for line in lines:
            chunk.append(line)
            if len(chunk) >= 4096:
                fh.write(eol.join(chunk) + eol)
                chunk.clear()
        if chunk:
            fh.write(eol.join(chunk) + eol)


class atomic_text:
    """Запись во временный файл рядом (своё имя на каждую запись — два сохранения в одно
    имя не пишут в один файл) и замена целевого по завершении; при ошибке старый файл цел.
    Временное имя начинается с точки — в списках файлов его не видно. `binary=True` —
    файл байтов."""

    def __init__(self, path: Path, binary: bool = False) -> None:
        self.path = Path(path)
        self.binary = binary

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
        self.tmp = Path(name)
        os.chmod(self.tmp, 0o644)             # mkstemp даёт 0600, а файлы трейсов — обычные
        self.fh = os.fdopen(fd, "wb") if self.binary else os.fdopen(fd, "w", encoding="utf-8", newline="")
        return self.fh

    def __exit__(self, exc_type, exc, tb) -> None:
        self.fh.close()
        if exc_type is None:
            os.replace(self.tmp, self.path)
        else:
            self.tmp.unlink(missing_ok=True)


def write_bytes_atomic(path: Path, data: bytes) -> None:
    with atomic_text(path, binary=True) as fh:
        fh.write(data)

