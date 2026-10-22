#!/bin/bash
# Проверка собранной CarBUS.app — окна и встроенного бэкенда; без прибора, в шину ничего не шлёт.
#   ready      окно поднимает бэкенд на 47800 и показывает интерфейс (снимок), после выхода бэкенда нет
#   orphan     окно убито (kill -9) — бэкенд уходит сам за 5 с и не держит USB-порт прибора
#   port-busy  47800 занят чужой программой — окно берёт другой порт
#   universal  каждый Mach-O в пакете x86_64 + arm64, подпись пакета цела
#   read-only  (если дан .dmg) программа запускается прямо с примонтированного тома
# У каждого случая свои данные и журналы (CARBUS_HOME) — во временной папке с пробелом и кириллицей.
# CARBUS_ARCH=x86_64 — все случаи на Intel-части программы под Rosetta.
#
#   macos/test-app.sh macos/build/CarBUS.app [macos/build/CarBUS-<версия>.dmg]
set -uo pipefail

APP="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
DMG="${2:-}"
RUN=()
[ -n "${CARBUS_ARCH:-}" ] && RUN=(arch "-$CARBUS_ARCH")
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

# новая папка данных для случая; метка (имя временной папки) отличает его процессы от чужих
case_home() { local tmp; tmp="$(mktemp -d)"; mkdir -p "$tmp/Тест папка"; echo "$tmp/Тест папка"; }
marker() { basename "$(dirname "$1")"; }
backend_pids() { pgrep -f "app.desktop.*$(marker "$1")" || true; }
wait_for() { # wait_for <секунд> <команда…> — ждать, пока команда не станет успешной
  local n=$(($1 * 10)); shift
  while [ "$n" -gt 0 ]; do "$@" && return 0; sleep 0.1; n=$((n - 1)); done
  return 1
}
gone() { [ -z "$(backend_pids "$1")" ]; }
ready_port() { sed -n 's/.*backend ready port=\([0-9]*\).*/\1/p' "$1/Logs/app.log" 2>/dev/null | tail -1; }
has_ready() { [ -n "$(ready_port "$1")" ]; }

# запуск окна со снимком и выходом; печатает порт бэкенда
run_snapshot() { # run_snapshot <программа.app> <CARBUS_HOME>
  CARBUS_HOME="$2" CARBUS_SNAPSHOT="$2/shot.png" CARBUS_QUIT_AFTER_SNAPSHOT=1 \
    perl -e 'alarm 90; exec @ARGV' ${RUN[@]+"${RUN[@]}"} "$1/Contents/MacOS/CarBUS" >/dev/null 2>&1
  ready_port "$2"
}
shot_ok() { [ -f "$1/shot.png" ] && [ "$(stat -f %z "$1/shot.png")" -gt 50000 ]; }

if [ ! -x "$APP/Contents/MacOS/CarBUS" ]; then
  fail "нет программы: $APP"
  exit 1
fi

# --- ready
H="$(case_home)"
port="$(run_snapshot "$APP" "$H")"
if [ "$port" = "47800" ] && shot_ok "$H" && wait_for 5 gone "$H"; then
  pass "ready: бэкенд на 47800, интерфейс показан, после выхода бэкенда нет"
else
  fail "ready: порт '${port}', снимок $(stat -f %z "$H/shot.png" 2>/dev/null || echo нет), бэкенд: $(backend_pids "$H")"
  tail -5 "$H/Logs/app.log" "$H/Logs/backend.log" 2>/dev/null
fi

# --- orphan
H="$(case_home)"
CARBUS_HOME="$H" ${RUN[@]+"${RUN[@]}"} "$APP/Contents/MacOS/CarBUS" >/dev/null 2>&1 &
WIN=$!
if wait_for 60 has_ready "$H"; then
  # «готов» значит, что сервер уже отвечает, а не что в кэше остался ответ прошлого запуска
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(ready_port "$H")/")"
  kill -9 "$WIN"
  if [ "$code" != 200 ]; then fail "orphan: окно сказало «готов», а сервер ответил '$code'"
  elif wait_for 5 gone "$H"; then pass "orphan: окно убито — бэкенд ушёл сам"
  else fail "orphan: бэкенд пережил окно: $(backend_pids "$H")"; fi
  kill -9 $(backend_pids "$H") 2>/dev/null
else
  fail "orphan: бэкенд не поднялся"; kill -9 "$WIN" 2>/dev/null
fi
wait "$WIN" 2>/dev/null

# --- port-busy
H="$(case_home)"
python3 -m http.server 47800 --bind 127.0.0.1 >/dev/null 2>&1 &
BUSY=$!
if wait_for 10 nc -z 127.0.0.1 47800; then
  port="$(run_snapshot "$APP" "$H")"
  if [ -n "$port" ] && [ "$port" != "47800" ] && shot_ok "$H"; then pass "port-busy: 47800 занят — взят порт $port"
  else fail "port-busy: порт '${port}', снимок $(stat -f %z "$H/shot.png" 2>/dev/null || echo нет)"; fi
else
  fail "port-busy: не удалось занять 47800 для проверки"
fi
kill "$BUSY" 2>/dev/null
wait "$BUSY" 2>/dev/null

# --- universal
bad=""
while IFS= read -r f; do
  file -b "$f" | grep -q Mach-O || continue
  archs="$(lipo -archs "$f" 2>/dev/null)"
  case "$archs" in *x86_64*arm64* | *arm64*x86_64*) ;; *) bad="$bad\n  ${f#"$APP/"} ($archs)" ;; esac
done < <(find "$APP" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \))
if [ -z "$bad" ] && codesign --verify --deep --strict "$APP" 2>/dev/null; then
  pass "universal: все Mach-O x86_64 + arm64, подпись цела"
else
  fail "universal: не универсальные:${bad:- нет}; подпись: $(codesign --verify --deep --strict "$APP" 2>&1 | tail -1)"
fi

# --- read-only (с .dmg)
if [ -n "$DMG" ]; then
  MNT="$(mktemp -d)"
  if hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" "$DMG"; then
    H="$(case_home)"
    port="$(run_snapshot "$MNT/CarBUS.app" "$H")"
    if [ -n "$port" ] && shot_ok "$H" && [ -L "$MNT/Программы" ]; then pass "read-only: запуск прямо с .dmg (порт $port), ярлык «Программы» есть"
    else fail "read-only: порт '${port}', снимок $(stat -f %z "$H/shot.png" 2>/dev/null || echo нет)"; fi
    hdiutil detach -quiet "$MNT"
  else
    fail "read-only: .dmg не монтируется: $DMG"
  fi
fi

[ "$FAILS" -eq 0 ] && echo "все проверки пройдены" || echo "провалено: $FAILS"
exit $((FAILS > 0))
