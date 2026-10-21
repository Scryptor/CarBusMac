#!/usr/bin/env bash
# Нативный мост на маке: сам находит CAN-Hacker на USB и отдаёт его бэкенду в Docker по TCP.
# Нужен, потому что Docker Desktop на macOS не пробрасывает USB в контейнер (на Linux можно
# обойтись без моста — см. docker-compose.usb.yml).
#
# Использование: ./run-bridge.sh [port]          (порт по умолчанию 7700)
#   Прибор можно подключать и отключать при работающем мосте: он ищет его при каждом
#   подключении, а в «Настройках устройства» список приборов обновляется сам.
#   CARBUS_SERIAL=/dev/cu.usbmodemXXX — открывать этот порт, даже если он не похож на
#                                       CAN-Hacker (прибор с другими USB-строками).
#   CARBUS_BRIDGE_HOST=0.0.0.0        — слушать не только localhost (по умолчанию 127.0.0.1).
#   CARBUS_PYTHON=/путь/к/python3     — Python 3.9+ для окружения моста.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-7700}"
VENV="${TMPDIR:-/tmp}/carbus-bridge-venv"

# Мосту нужны только pyserial и pyserial-asyncio — тех же версий, что у бэкенда.
pin() { sed -n "s/^$1==//p" "$ROOT/backend/constraints.txt"; }
PYSERIAL="$(pin pyserial)"
PYSERIAL_ASYNCIO="$(pin pyserial-asyncio)"
if [ -z "$PYSERIAL" ] || [ -z "$PYSERIAL_ASYNCIO" ]; then
  echo "В backend/constraints.txt нет версий pyserial / pyserial-asyncio." >&2
  exit 1
fi

# Подойдёт и системный python3 macOS (3.9); новее — лучше.
PY=""
for cand in "${CARBUS_PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 \
     && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PY="$cand"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "Нужен Python 3.9 или новее: установите Xcode Command Line Tools (xcode-select --install)," >&2
  echo "или brew install python@3.12, или задайте CARBUS_PYTHON=/путь/к/python3." >&2
  exit 1
fi

# Окружение проверяем по факту: импортируются ли пакеты нужных версий. Недоделанное
# (оборвалась сеть при первой установке) или старое пересоздаётся, а не используется молча.
have_deps() {
  "$VENV/bin/python" -c "import importlib.metadata as m, sys; import serial, serial_asyncio; \
sys.exit(0 if (m.version('pyserial'), m.version('pyserial-asyncio')) == ('$PYSERIAL', '$PYSERIAL_ASYNCIO') else 1)" \
    >/dev/null 2>&1
}
if ! have_deps; then
  echo "Создаю окружение для моста в $VENV …"
  rm -rf "$VENV"
  "$PY" -m venv "$VENV"
  if ! PIP_DISABLE_PIP_VERSION_CHECK=1 "$VENV/bin/pip" -q install "pyserial==$PYSERIAL" "pyserial-asyncio==$PYSERIAL_ASYNCIO"; then
    rm -rf "$VENV"
    echo "Не удалось установить pyserial (нет сети?). Запустите скрипт ещё раз." >&2
    exit 1
  fi
fi

# По умолчанию — только loopback: Docker Desktop на маке дотягивается до сервисов хоста на
# 127.0.0.1 через host.docker.internal, а в локальную сеть мост не публикуется. Порт 7700
# на маке обычно свободен (не 7000: тот на macOS 12+ держит «Приёмник AirPlay»); другой —
# первым аргументом и тот же в «Настройках устройства» → «Дополнительно».
BIND="${CARBUS_BRIDGE_HOST:-127.0.0.1}"
ARGS=(--host "$BIND" --port "$PORT")
[ -z "${CARBUS_SERIAL:-}" ] || ARGS+=(--serial "$CARBUS_SERIAL")
cd "$ROOT/backend"
exec env PYTHONPATH="$ROOT/backend" PYTHONDONTWRITEBYTECODE=1 "$VENV/bin/python" -m app.bridge "${ARGS[@]}"
