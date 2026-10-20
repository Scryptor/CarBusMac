"""Персистентное состояние приложения в JSON-файлах (каталог ./data, смонтирован с
мака): настройки, подключение, список передачи, фильтры, комментарии, скорости.
Запись атомарная (tmp + os.replace), битый файл не роняет запуск — берётся default."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class JsonStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, name: str) -> Path:
        return self.root / f"{name}.json"

    def load(self, name: str, default: Any) -> Any:
        try:
            return json.loads(self._path(name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def save(self, name: str, data: Any) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(name)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
