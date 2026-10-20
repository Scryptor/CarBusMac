#!/usr/bin/env bash
# Нативный мост на маке: держит USB-порт программатора и отдаёт его контейнеру по TCP.
# Нужен, потому что Docker на macOS не прокидывает USB в Linux-VM.
# Использование: ./run-bridge.sh [port]   (порт по умолчанию 7000)
#   CARBUS_SERIAL=/dev/cu.usbmodemXXX  — задать порт вручную, иначе автоподбор.
set -euo pipefail

PORT="${1:-7000}"
DEV="${CARBUS_SERIAL:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1 || true)}"
if [ -z "$DEV" ]; then
  echo "Программатор не найден (/dev/cu.usbmodem*). Подключите его или задайте CARBUS_SERIAL." >&2
  exit 1
fi

VENV="${TMPDIR:-/tmp}/carbus-bridge-venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Создаю venv для моста в $VENV …"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" -q install --upgrade pip
  "$VENV/bin/pip" -q install carbus-lib
fi

# По умолчанию слушаем только loopback: Docker Desktop на маке дотягивается до
# сервисов хоста на 127.0.0.1 через host.docker.internal (проверено). Это не
# публикует мост в LAN. Если ваш рантайм не достаёт loopback — задайте
# CARBUS_BRIDGE_HOST=0.0.0.0 (и держите firewall включённым).
BIND="${CARBUS_BRIDGE_HOST:-127.0.0.1}"
echo "Мост: $DEV → $BIND:$PORT  (контейнер ходит через host.docker.internal:$PORT)"
[ "$BIND" = "127.0.0.1" ] || echo "ВНИМАНИЕ: мост слушает $BIND — не только localhost; следите за firewall."
exec "$VENV/bin/python" -m carbus_async.tcp_bridge --serial "$DEV" --port "$PORT" --host "$BIND"
