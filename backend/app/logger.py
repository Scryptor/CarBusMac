"""Фоновое логирование потока (окно «Настройки записей трейсов» десктопа).

Пока прибор подключён, принятые (и, если включено, отправленные) кадры пишутся в
`<маска>.trc` в папке трейсов. Формат — тот же `.trc` v3, что у «Сохранить поток»;
число кадров и длительность в заголовке известны только в конце, поэтому строки идут во
временный `.part`, а при остановке собирается итоговый файл: заголовок, `# $LocalTime`,
метаинформация (`# TransportBrand=…`) и строки."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from app.models import CanFrame
from app.tracefmt import EOL, trc_frame_line, trc_header

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
        if self._t_first is None:
            self._t_first = f.timestamp
            self._local_time = self.now()
        self._t_last = f.timestamp
        self._fh.write(trc_frame_line(f, self._t_first) + EOL)
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
