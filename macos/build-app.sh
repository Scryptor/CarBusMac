#!/bin/bash
# Сборка CarBUS.app — программы для мака без Docker и моста
# (docs/superpowers/specs/2026-10-22-mac-app-design.md): окно на Swift + встроенный Python
# (python-build-standalone) с бэкендом и собранным интерфейсом. Python и колёса ставятся для arm64
# и x86_64 и сшиваются lipo — один пакет для любых маков. Подпись — ad-hoc.
#
#   macos/build-app.sh [--version 0.1.0] [--dmg]
#
# Нужны: Xcode (swiftc), собранный интерфейс (cd frontend && npm ci && npm run build), интернет
# (Python с GitHub, колёса с PyPI). Результат — macos/build/CarBUS.app (с --dmg — ещё
# CarBUS-<версия>.dmg); проверка — macos/test-app.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$ROOT/macos"
WORK="$MAC/work"
OUT="$MAC/build"
VERSION=0.0.0
MAKE_DMG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dmg) MAKE_DMG=1; shift ;;
    *) echo "неизвестный ключ: $1" >&2; exit 2 ;;
  esac
done

PBS=20261021      # релиз python-build-standalone
PYV=3.12.15
PYMM=3.12
sha_for() {
  case "$1" in
    aarch64) echo 7b8d00b751db21cea87dc551a8f8165147c5fbc5251d5537d7e5497dde00a219 ;;
    x86_64) echo f12e0504397683d6be0745ffd4c39ef45a455cec169adf35c628840d06133773 ;;
  esac
}
# колёса, которые работают на macOS 12+ для каждой архитектуры
tags_for() {
  case "$1" in
    aarch64) echo macosx_11_0_arm64 macosx_12_0_arm64 macosx_10_9_universal2 macosx_10_15_universal2 macosx_11_0_universal2 ;;
    x86_64) echo macosx_10_9_x86_64 macosx_10_12_x86_64 macosx_10_13_x86_64 macosx_10_15_x86_64 macosx_11_0_x86_64 \
      macosx_12_0_x86_64 macosx_10_9_universal2 macosx_10_15_universal2 macosx_11_0_universal2 ;;
  esac
}
step() { printf '\n== %s\n' "$*"; }
# кандидаты в Mach-O: модули, библиотеки, исполняемые
machos() { find "$1" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0; }
is_macho() { file -b "$1" | grep -q Mach-O; }

[ -f "$ROOT/frontend/dist/index.html" ] || { echo "нет frontend/dist — сначала: cd frontend && npm ci && npm run build" >&2; exit 1; }
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
[ -d "$SDK" ] || SDK="$(xcode-select -p)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
[ -d "$SDK" ] || { echo "не найден macOS SDK — нужен Xcode" >&2; exit 1; }
mkdir -p "$WORK/dl" "$OUT"

# 1. Python обеих архитектур: закреплённая версия, проверка контрольной суммы
for arch in aarch64 x86_64; do
  step "Python $PYV ($arch)"
  name="cpython-$PYV+$PBS-$arch-apple-darwin-install_only_stripped.tar.gz"
  tgz="$WORK/dl/$name"
  [ -f "$tgz" ] || curl -fsSL --retry 3 -o "$tgz" \
    "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS/${name/+/%2B}"
  if ! echo "$(sha_for "$arch")  $tgz" | shasum -a 256 -c - >/dev/null; then
    rm -f "$tgz"
    echo "контрольная сумма не сошлась: $name" >&2
    exit 1
  fi
  rm -rf "$WORK/py-$arch"
  mkdir -p "$WORK/py-$arch"
  tar -xzf "$tgz" -C "$WORK/py-$arch" --strip-components 1
done

# 2. Зависимости бэкенда — ровно [project].dependencies, только колёса под macOS 12+
case "$(uname -m)" in
  arm64) HOSTPY="$WORK/py-aarch64/bin/python3" ;;
  *) HOSTPY="$WORK/py-x86_64/bin/python3" ;;
esac
DEPS=()
while IFS= read -r dep; do DEPS+=("$dep"); done < <("$HOSTPY" -c \
  'import sys, tomllib; print("\n".join(tomllib.load(open(sys.argv[1], "rb"))["project"]["dependencies"]))' \
  "$ROOT/backend/pyproject.toml")
for arch in aarch64 x86_64; do
  step "зависимости ($arch): ${DEPS[*]}"
  plat=()
  for tag in $(tags_for "$arch"); do plat+=(--platform "$tag"); done
  site="$WORK/py-$arch/lib/python$PYMM/site-packages"
  "$HOSTPY" -m pip install -q --disable-pip-version-check --no-cache-dir --upgrade --target "$site" \
    --only-binary=:all: --implementation cp --python-version "$PYMM" --abi "cp${PYMM/./}" "${plat[@]}" \
    -c "$ROOT/backend/constraints.txt" "${DEPS[@]}"
  rm -rf "$site/bin"            # скрипты-обёртки с путём к Python сборочной машины
done

# 3. Лишнее: tkinter, тесты, pip — программе не нужны, а место занимают
for arch in aarch64 x86_64; do
  py="$WORK/py-$arch"
  lib="$py/lib/python$PYMM"
  rm -rf "$lib/test" "$lib/idlelib" "$lib/tkinter" "$lib/turtledemo" "$lib/ensurepip" "$lib/lib2to3" \
    "$lib/config-$PYMM-darwin" "$lib/site-packages/pip" "$lib"/site-packages/pip-*.dist-info \
    "$lib"/lib-dynload/_tkinter* "$py"/lib/libtcl* "$py"/lib/libtk* "$py"/lib/tcl* "$py"/lib/tk* \
    "$py"/lib/itcl* "$py"/lib/thread* "$py/lib/pkgconfig" "$py/include" "$py/share" \
    "$py"/bin/idle* "$py"/bin/pip* "$py"/bin/pydoc* "$py"/bin/2to3* "$py"/bin/python*-config
  find "$py" -name __pycache__ -type d -prune -exec rm -rf {} +
done

# 4. Один универсальный Python: дерево arm64 — основа, у каждого Mach-O — пара из x86_64
step "универсальный Python"
U="$WORK/py-universal"
rm -rf "$U"
ditto "$WORK/py-aarch64" "$U"
list() { (cd "$1" && find . \( -type f -o -type l \) | LC_ALL=C sort); }
if ! diff <(list "$WORK/py-aarch64") <(list "$WORK/py-x86_64") >"$WORK/files.diff"; then
  echo "у архитектур разные наборы файлов:" >&2
  head -20 "$WORK/files.diff" >&2
  exit 1
fi
joined=0
while IFS= read -r -d '' f; do
  rel="${f#"$WORK/py-aarch64/"}"
  is_macho "$f" || continue
  case "$(lipo -archs "$f")" in *x86_64*) continue ;; esac      # колесо уже universal2
  lipo -create "$f" "$WORK/py-x86_64/$rel" -output "$U/$rel"
  joined=$((joined + 1))
done < <(machos "$WORK/py-aarch64")
echo "сшито Mach-O: $joined"

# 5. Окно — универсальный Mach-O
step "окно"
for target in arm64 x86_64; do
  swiftc -O -swift-version 5 -sdk "$SDK" -target "$target-apple-macos12" -o "$WORK/CarBUS-$target" \
    "$MAC"/CarBUS/*.swift -framework Cocoa -framework WebKit
done

# 6. Пакет
step "CarBUS.app $VERSION"
APP="$OUT/CarBUS.app"
C="$APP/Contents"
R="$C/Resources"
rm -rf "$APP"
mkdir -p "$C/MacOS" "$R/app/backend" "$R/app/frontend"
lipo -create "$WORK/CarBUS-arm64" "$WORK/CarBUS-x86_64" -output "$C/MacOS/CarBUS"
ditto "$U" "$R/python"
ditto "$ROOT/backend/app" "$R/app/backend/app"
ditto "$ROOT/frontend/dist" "$R/app/frontend/dist"
find "$R/app" -name __pycache__ -type d -prune -exec rm -rf {} +
cp "$MAC/AppIcon.icns" "$R/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$(date +%Y%m%d%H%M)/" "$MAC/Info.plist" >"$C/Info.plist"
plutil -lint "$C/Info.plist" >/dev/null

# 7. .pyc заранее: в свой пакет программа не пишет
"$R/python/bin/python3" -m compileall -q -j 0 --invalidation-mode unchecked-hash \
  "$R/app/backend" "$R/python/lib/python$PYMM" >/dev/null

# 8. Подпись ad-hoc: каждый вложенный Mach-O, затем пакет
step "подпись"
signed=0
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  codesign --force -s - "$f" 2>/dev/null
  signed=$((signed + 1))
done < <(machos "$R")
codesign --force -s - "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP"
echo "подписано вложенных Mach-O: $signed"
echo "пакет: $APP ($(du -sh "$APP" | cut -f1))"

# 9. .dmg: программа и ярлык «Программы» — перетащить одно на другое
if [ "$MAKE_DMG" = 1 ]; then
  step ".dmg"
  stage="$WORK/dmg"
  rm -rf "$stage"
  mkdir -p "$stage"
  ditto "$APP" "$stage/CarBUS.app"
  ln -s /Applications "$stage/Программы"
  DMG="$OUT/CarBUS-$VERSION.dmg"
  hdiutil create -quiet -volname CarBUS -srcfolder "$stage" -format UDZO -ov "$DMG"
  echo "образ: $DMG ($(du -h "$DMG" | cut -f1))"
fi
