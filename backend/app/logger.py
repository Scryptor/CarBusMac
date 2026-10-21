"""Фоновое логирование потока (окно «Настройки записей трейсов» десктопа).

Пока прибор подключён, принятые (и, если включено, отправленные) кадры пишутся в
`<маска>.trc` в папке трейсов. Формат — тот же `.trc` v3, что у «Сохранить поток»;
число кадров и длительность в заголовке известны только в конце, поэтому строки идут во
временный `.part`, а при остановке собирается итоговый файл: заголовок, `# $LocalTime`,
метаинформация (`# TransportBrand=…`) и строки. Если бэкенд упал, не закрыв лог,
`recover_parts` при следующем запуске собирает `.trc` из оставшегося `.part`."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from app.models import CanFrame
from app.tracefmt import EOL, _parse_time_us, atomic_text, trc_frame_line, trc_header

_MINUTE_US = 60_000_000
PART_STALE_S = 60.0       # .part, который не менялся столько, — брошенный (его не пишут)

DEFAULT_MASK = "%Y-%m-%d_%H-%M-%S"

# ключи метаинформации в .trc — по именам полей вкладки «Метаинформация» десктопа
META_KEYS = {
    "transport": "TransportType",
    "brand": "TransportBrand",
    "model": "TransportModel",
    "body": "TransportBody",
    "year": "TransportYear",
}


def trc_meta(log_meta: dict[str, str]) -> dict[str, str]:
    """Настройки «Метаинформация» → строки `# Ключ=значение` трейса (пустые не пишем)."""
    return {META_KEYS[k]: str(v) for k, v in log_meta.items() if k in META_KEYS and str(v).strip()}


def _safe_stem(text: str) -> str:
    s = re.sub(r"[^\w.\- ]", "_", text)
    s = re.sub(r"_+", "_", s).lstrip("._ -").rstrip(". ")
    return s or "log"


class StreamLogger:
    def __init__(self, traces_dir: Path, settings: dict[str, Any], now: Callable[[], datetime] = datetime.now) -> None:
        self.dir = Path(traces_dir)
        self.settings = settings
        self.now = now
        self.path: Path | None = None
        self._part: Path | None = None
        self._fh = None
        self._meta: dict[str, str] = {}
        self._count = 0
        self._t_first: float | None = None
        self._t_last = 0.0
        self._local_time: datetime | None = None

    @property
    def active(self) -> bool:
        return self._fh is not None

    def _name(self) -> Path:
        mask = str(self.settings.get("log_name_mask") or DEFAULT_MASK)
        try:
            stem = self.now().strftime(mask)
        except ValueError:
            stem = self.now().strftime(DEFAULT_MASK)
        stem = _safe_stem(stem)
        path = self.dir / f"{stem}.trc"
        n = 2
        while path.exists() or path.with_suffix(".trc.part").exists():
            path = self.dir / f"{stem}_{n}.trc"
            n += 1
        return path

    def start(self, meta: dict[str, str]) -> Path:
        if self.active:
            self.stop()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self._name()
        self._part = self.path.with_suffix(".trc.part")
        self._fh = self._part.open("w", encoding="utf-8", newline="")
        self._meta = dict(meta)
        self._count = 0
        self._t_first = None
        self._local_time = None
        return self.path

    def write(self, f: CanFrame) -> None:
        if self._fh is None:
            return
        if f.direction == "tx" and not self.settings.get("log_record_tx", True):
            return
        ts = f.timestamp
        if self._t_first is None:
            self._t_first = self._t_last = ts
            self._local_time = self.now()
        elif ts < self._t_last:
            ts = self._t_last        # в .trc время не может идти назад (при чтении это +60 с)
        self._t_last = ts
        self._fh.write(trc_frame_line(f, self._t_first, ts=ts) + EOL)
        self._count += 1

    def stop(self) -> Path | None:
        """Собирает итоговый файл; пустой лог (не было кадров) удаляется — возвращает None."""
        if self._fh is None:
            return None
        self._fh.close()
        self._fh = None
        part, path = self._part, self.path
        if self._count == 0 or part is None or path is None:
            if part is not None:
                part.unlink(missing_ok=True)
            return None
        dur_ms = round((self._t_last - (self._t_first or 0.0)) * 1000)
        head = trc_header(self._count, dur_ms, self._local_time, self._meta)
        with path.open("w", encoding="utf-8", newline="") as out, part.open("r", encoding="utf-8", newline="") as src:
            out.write(EOL.join(head) + EOL)
            while chunk := src.read(1 << 20):
                out.write(chunk)
        part.unlink(missing_ok=True)
        return path


def _scan_part(part: Path) -> tuple[int, int, int]:
    """Кадров, длительность (мс) и сколько байт от начала — целые строки. Строка,
    оборванная сбоем, и всё после неё отбрасываются."""
    count = good = 0
    prev: int | None = None
    offset = 0
    first = last = 0
    pos = 0
    with part.open("rb") as fh:
        for raw in fh:
            nxt = pos + len(raw)
            if not raw.endswith(b"\n"):
                break
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line:
                fields = line.split("\t")
                if len(fields) < 8:
                    break
                try:
                    t = _parse_time_us(fields[0])
                except ValueError:
                    break
                if prev is not None and t < prev:
                    offset += _MINUTE_US
                prev = t
                if count == 0:
                    first = offset + t
                last = offset + t
                count += 1
            good = pos = nxt
    return count, round((last - first) / 1000), good


def recover_parts(traces_dir: Path, now: float | None = None) -> list[Path]:
    """Собрать `.trc` из брошенных `.trc.part` (бэкенд упал или его убили, не закрыв лог).
    Время начала записи не сохранилось — `# $LocalTime` в таком файле нет."""
    out: list[Path] = []
    d = Path(traces_dir)
    if not d.is_dir():
        return out
    for part in sorted(d.glob("*.trc.part")):
        try:
            if now is not None and now - part.stat().st_mtime < PART_STALE_S:
                continue                              # может ещё писаться
            count, dur_ms, good = _scan_part(part)
            if count == 0:
                part.unlink(missing_ok=True)
                continue
            target = part.with_name(part.name[: -len(".part")])
            n = 2
            while target.exists():
                target = part.with_name(f"{part.name[: -len('.trc.part')]}_{n}.trc")
                n += 1
            # во временный файл и замена: убитый посреди сборки процесс не оставит обрезанный .trc
            with atomic_text(target, binary=True) as dst, part.open("rb") as src:
                dst.write((EOL.join(trc_header(count, dur_ms, None, {})) + EOL).encode("utf-8"))
                left = good
                while left > 0 and (chunk := src.read(min(left, 1 << 20))):
                    dst.write(chunk)
                    left -= len(chunk)
            part.unlink(missing_ok=True)
            out.append(target)
        except OSError:
            continue
    return out
