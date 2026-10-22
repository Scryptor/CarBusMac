"""Снимок приборов (свой USB + мост) и выбор прибора для подключения."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.bridge import BridgeDown, BridgeForeign
from app.devices import DeviceError, bridge_command, discover, pick
from app.usbports import describe

CFG = {"bridge_host": "host.docker.internal", "bridge_port": 7700}
HACKER = describe("/dev/cu.usbmodem00000000001A1", product="CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201",
                  manufacturer="Spectratek", vid=0x0483, pid=0x5740, serial_number="00000000001A")
LG = describe("/dev/cu.usbmodem506NTBKGE1012", product="LG Monitor Controls", vid=0x043E, pid=0x9A39)
ACM = describe("/dev/ttyACM0", product="CAN-Hacker v3.2 0000000000000ABC 2.2.3.57 A0", vid=0x0483, pid=0x5740)


def listing(ports=None, exc=None):
    async def fn(host, port, timeout):
        assert (host, port) == ("host.docker.internal", 7700)
        if exc:
            raise exc
        return [{**p, "busy": False, "forced": False} for p in ports or []]
    return fn


async def test_mac_app_without_bridge_finds_usb_and_reports_bridge_off():
    snap = await discover(CFG, scan=lambda: [HACKER, LG], listing=None, container=False)
    assert snap["bridge"]["state"] == "off"
    assert [(d["key"], d["selectable"]) for d in snap["devices"]] == [
        ("usb:/dev/cu.usbmodem00000000001A1", True), ("usb:/dev/cu.usbmodem506NTBKGE1012", False)]
    assert snap["hint"] == ""


async def test_mac_app_without_bridge_and_device_asks_only_for_usb():
    snap = await discover(CFG, scan=lambda: [LG], listing=None, container=False)
    assert snap["bridge"]["state"] == "off"
    assert snap["hint"] == "CAN-Hacker не найден. Подключите его к USB — он появится здесь сам."
    for word in ("Мост", "мост", "Docker", "run-bridge"):
        assert word not in snap["hint"]


async def test_mac_docker_sees_the_device_through_the_bridge_only():
    snap = await discover(CFG, scan=lambda: [], listing=listing([HACKER, LG]), container=True)
    assert [(d["key"], d["selectable"]) for d in snap["devices"]] == [
        ("bridge:/dev/cu.usbmodem00000000001A1", True), ("bridge:/dev/cu.usbmodem506NTBKGE1012", False)]
    assert {k: snap["bridge"][k] for k in ("state", "address", "message")} == {
        "state": "ok", "address": "host.docker.internal:7700", "message": ""}
    assert snap["usb"] == {"state": "ok", "in_container": True} and snap["hint"] == ""
    assert pick(snap, "")["path"] == "/dev/cu.usbmodem00000000001A1"


async def test_same_device_seen_twice_is_listed_once_via_direct_usb():
    snap = await discover(CFG, scan=lambda: [HACKER], listing=listing([HACKER]), container=False)
    assert [d["key"] for d in snap["devices"]] == ["usb:/dev/cu.usbmodem00000000001A1"]


async def test_hint_explains_why_nothing_was_found():
    down = await discover(CFG, scan=lambda: [], listing=listing(exc=BridgeDown("соединение отклонено")))
    assert down["bridge"]["state"] == "down" and "./run-bridge.sh" in down["hint"]
    foreign = await discover(CFG, scan=lambda: [], listing=listing(exc=BridgeForeign("нет приветствия")))
    assert foreign["bridge"]["state"] == "foreign" and "другая программа" in foreign["hint"]
    assert "./run-bridge.sh" in foreign["hint"]
    empty = await discover(CFG, scan=lambda: [LG], listing=listing([]))
    assert empty["hint"] == "Мост работает, но CAN-Hacker не подключён по USB."
    with pytest.raises(DeviceError, match="не подключён по USB"):
        pick(empty, "")


async def test_linux_container_with_usb_passthrough_needs_no_bridge():
    snap = await discover(CFG, scan=lambda: [ACM], listing=listing(exc=BridgeDown("соединение отклонено")),
                          container=True)
    assert snap["hint"] == "" and pick(snap, "")["key"] == "usb:/dev/ttyACM0"


async def test_broken_usb_enumeration_still_leaves_the_bridge():
    def boom():
        raise OSError("no sysfs")
    snap = await discover(CFG, scan=boom, listing=listing([HACKER]))
    assert snap["usb"]["state"] == "unavailable" and len(snap["devices"]) == 1


async def test_pick_by_key_and_its_fallbacks():
    snap = await discover(CFG, scan=lambda: [ACM], listing=listing([HACKER, LG]))
    assert pick(snap, "bridge:/dev/cu.usbmodem00000000001A1")["source"] == "bridge"
    with pytest.raises(DeviceError, match="несколько"):
        pick(snap, "")                                  # два CAN-Hacker — без выбора не подключаемся
    with pytest.raises(DeviceError, match="не CAN-Hacker"):
        pick(snap, "bridge:/dev/cu.usbmodem506NTBKGE1012")
    with pytest.raises(DeviceError, match="не найден"):
        pick(snap, "bridge:/dev/cu.usbmodemGONE")
    # тот же порт, но теперь виден другим путём (был мост, стал проброс в контейнер)
    assert pick(snap, "bridge:/dev/ttyACM0")["key"] == "usb:/dev/ttyACM0"


async def test_bridge_entries_are_sanitised():
    weird = {"path": "/dev/x", "kind": "evil", "title": 5, "serial": "1", "vid": True, "busy": 1}
    snap = await discover(CFG, scan=lambda: [], listing=listing([weird]))
    d = snap["devices"][0]
    assert (d["kind"], d["title"], d["serial"], d["vid"], d["selectable"]) == ("other", "x", None, None, False)


# Команду запуска моста интерфейс показывает для Терминала мака — проверяем её в настоящих
# оболочках (zsh — оболочка Терминала) на поддельном run-bridge.sh, который сообщает, откуда и
# с какими аргументами его запустили.
SHELLS = [pytest.param(["/bin/sh", "-c"], id="sh")]
if shutil.which("zsh"):
    SHELLS.append(pytest.param(["zsh", "-f", "-c"], id="zsh"))


def fake_bridge(folder: Path) -> None:
    folder.mkdir(parents=True)
    script = folder / "run-bridge.sh"
    script.write_text('#!/bin/sh\necho "bridge: $(pwd -P) $*"\n')
    script.chmod(0o755)


def run(shell: list[str], command: str, **env: str) -> str:
    return subprocess.run([*shell, command], capture_output=True, text=True, check=True,
                          env={**os.environ, **env}).stdout.strip()


@pytest.mark.parametrize("shell", SHELLS)
@pytest.mark.parametrize(("port", "args"), [(7700, ""), (7000, " 7000")])     # 7700 — порт моста по умолчанию
def test_bridge_command_starts_the_bridge_in_the_project_folder(tmp_path, shell, port, args):
    folder = (tmp_path / "My Projects" / "carbus-mac").resolve()     # пробел в пути
    fake_bridge(folder)
    assert run(shell, bridge_command(port, str(folder))) == f"bridge: {folder}{args}"


@pytest.mark.parametrize("shell", SHELLS)
def test_without_the_project_folder_the_command_fetches_it_from_github_once(tmp_path, shell):
    home, tools, template = tmp_path / "home", tmp_path / "bin", tmp_path / "template"
    home.mkdir()
    tools.mkdir()
    fake_bridge(template)
    git = tools / "git"      # «клонирует» поддельный мост и записывает, как его вызвали
    git.write_text(f'#!/bin/sh\necho "$*" >> "$HOME/git.log"\nmkdir -p "$3" && cp "{template}/run-bridge.sh" "$3/"\n')
    git.chmod(0o755)
    env = {"HOME": str(home.resolve()), "PATH": f"{tools}:{os.environ['PATH']}"}
    target = home.resolve() / "CarBusMac"
    assert run(shell, bridge_command(7700, ""), **env) == f"bridge: {target}"
    assert run(shell, bridge_command(7700, ""), **env) == f"bridge: {target}"      # второй раз — без клонирования
    assert (home / "git.log").read_text().splitlines() == [f"clone https://github.com/Scryptor/CarBusMac.git {target}"]


async def test_snapshot_says_how_to_start_the_bridge_in_the_folder_docker_was_started_from(monkeypatch):
    monkeypatch.setenv("CARBUS_HOST_DIR", "/Users/igor/dev/canH/carbus-mac")      # docker-compose: ${PWD}
    async def down(host, port, timeout):
        raise BridgeDown("соединение отклонено")
    snap = await discover({"bridge_host": "host.docker.internal", "bridge_port": 7070}, scan=lambda: [],
                          listing=down, container=True)
    assert snap["bridge"]["project_dir"] == "/Users/igor/dev/canH/carbus-mac"
    assert snap["bridge"]["command"] == "cd /Users/igor/dev/canH/carbus-mac && ./run-bridge.sh 7070"


async def test_container_started_without_the_project_offers_to_fetch_it(monkeypatch):
    monkeypatch.delenv("CARBUS_HOST_DIR", raising=False)
    snap = await discover(CFG, scan=lambda: [], listing=listing(exc=BridgeDown("соединение отклонено")),
                          container=True)
    assert snap["bridge"]["project_dir"] == ""
    assert "git clone https://github.com/Scryptor/CarBusMac.git" in snap["bridge"]["command"]
