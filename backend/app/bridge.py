"""Нативный мост CarBUS: USB-порт CAN-Hacker ↔ TCP для бэкенда в Docker.

Docker Desktop на macOS не пробрасывает USB в контейнер, поэтому порт прибора держит этот
процесс на самом маке (`./run-bridge.sh`), а бэкенд ходит к нему по TCP через
host.docker.internal. О протоколе прибора мост не знает: он находит порты (app/usbports.py)
и перекладывает байты.

Протокол — строки JSON:
  мост → клиент, через GREETING_DELAY_S после подключения: {"bridge": "carbus", "version": 1}
  клиент → мост: «LIST» — ответ {"ok": true, "ports": [...]}, соединение закрывается;
                 «OPEN <порт|auto>» — ответ {"ok": true, "port": {...}}, дальше сырые байты
                 прибора в обе стороны; или {"ok": false, "error": "…"} и закрытие.
Приветствие шлёт мост, клиент до него молчит: если по адресу слушает не мост (прежний
tcp_bridge из carbus-lib, другая программа на этом порту), клиент не дождётся приветствия
и ничего не отправит — через чужой мост в прибор не уходит ни байта.

Клиент, который сразу шлёт байты протокола прибора (`CarBusDevice.open_tcp` из carbus-lib),
приветствия не ждёт: мост видит данные раньше GREETING_DELAY_S и работает как прежний
tcp_bridge — открывает единственный найденный CAN-Hacker (или --serial).

Открывается только порт, распознанный как CAN-Hacker / совместимый, или заданный явно
(--serial, он же CARBUS_SERIAL): служебные порты мониторов, плат и телефонов мост не трогает.

    python -m app.bridge [--host 127.0.0.1] [--port 7700] [--serial /dev/cu.usbmodem…]

Только стандартная библиотека, pyserial и pyserial-asyncio — Python 3.9+ (окружение моста)."""
from __future__ import annotations

import argparse
import asyncio
import errno
import json
import logging
import os
import signal
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from app.usbports import describe, label, scan_ports

PROTOCOL_VERSION = 1
# Порт моста по умолчанию. Не 7000 (порт tcp_bridge из carbus-lib): на macOS 12+ его на всех
# адресах держит «Приёмник AirPlay», и без моста бэкенд попадал в AirPlay вместо «не запущен».
DEFAULT_PORT = 7700
GREETING_DELAY_S = 0.1     # столько мост ждёт байтов от клиента старого образца
COMMAND_TIMEOUT_S = 5.0    # строка команды после приветствия
BUSY_WAIT_S = 1.5          # порт прошлого подключения ещё закрывается — подождать
WATCH_S = 2.0              # как часто мост пишет в консоль о подключённых/отключённых приборах
BAUDRATE = 115200          # у USB CDC скорость порта ни на что не влияет
CHUNK = 65536

log = logging.getLogger("carbus.bridge")

Streams = tuple[asyncio.StreamReader, asyncio.StreamWriter]


class BridgeError(Exception):
    """Отказ моста — текст для пользователя."""


class BridgeDown(ConnectionError):
    """По адресу моста никто не отвечает."""


class BridgeForeign(ConnectionError):
    """По адресу отвечает не мост CarBUS."""


class BridgeRefused(ConnectionError):
    """Мост ответил отказом (текст — от моста)."""


def _line(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def _peer(writer: asyncio.StreamWriter) -> str:
    peer = writer.get_extra_info("peername")
    return f"{peer[0]}:{peer[1]}" if isinstance(peer, tuple) and len(peer) >= 2 else str(peer or "?")


def selectable(p: dict[str, Any]) -> bool:
    return p["kind"] != "other" or bool(p.get("forced"))


async def open_serial(path: str) -> Streams:
    import serial_asyncio

    # exclusive: второй процесс (ещё один мост, десктоп в виртуалке) получит понятный отказ,
    # а не станет делить порт и путать ответы прибора
    return await serial_asyncio.open_serial_connection(url=path, baudrate=BAUDRATE, exclusive=True)


async def _copy(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await src.read(CHUNK)
            if not data:
                return
            dst.write(data)
            await dst.drain()
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        return            # прибор выдернули из USB или клиент ушёл


# ----------------------------------------------------------------- сервер (мак)
class Bridge:
    def __init__(self, forced: str | None = None,
                 scan: Callable[[], list[dict[str, Any]]] = scan_ports,
                 opener: Callable[[str], Awaitable[Streams]] = open_serial) -> None:
        self.forced = forced
        self.scan = scan
        self.opener = opener
        self.busy: set[str] = set()

    def ports(self) -> list[dict[str, Any]]:
        ports = self.scan()
        if self.forced:
            for p in ports:
                if p["path"] == self.forced:
                    p["forced"] = True
                    break
            else:   # порт без USB-описателей (или не виден перечислению) — всё равно предложить
                ports.insert(0, {**describe(self.forced), "forced": True})
        for p in ports:
            p.setdefault("forced", False)
            p["busy"] = p["path"] in self.busy
        return ports

    def resolve(self, want: str) -> dict[str, Any]:
        ports = self.ports()
        if want in ("", "auto"):
            cands = ([p for p in ports if p["forced"]] or [p for p in ports if p["kind"] == "canhacker"]
                     or [p for p in ports if p["kind"] == "compatible"])
            if len(cands) == 1:
                return cands[0]
            if not cands:
                raise BridgeError("CAN-Hacker не найден на USB этого компьютера")
            raise BridgeError("Найдено несколько CAN-Hacker (" + ", ".join(p["path"] for p in cands)
                              + ") — выберите нужный в «Настройках устройства»")
        for p in ports:
            if p["path"] == want:
                if not selectable(p):
                    raise BridgeError(f"{label(p)} — не CAN-Hacker, мост такой порт не открывает "
                                      "(если это всё же прибор — запустите мост с CARBUS_SERIAL=…)")
                return p
        raise BridgeError(f"Порт {want} не найден — прибор отключён от USB?")

    async def open(self, port: dict[str, Any]) -> Streams:
        path = port["path"]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + BUSY_WAIT_S
        while path in self.busy:
            if loop.time() >= deadline:
                raise BridgeError(f"{label(port)} уже открыт другим подключением")
            await asyncio.sleep(0.05)
        self.busy.add(path)
        try:
            return await self.opener(path)
        except Exception as e:
            self.busy.discard(path)
            raise BridgeError(f"Не удалось открыть {label(port)}: {e}") from None
        except BaseException:
            self.busy.discard(path)
            raise

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                early: bytes | None = await asyncio.wait_for(reader.read(CHUNK), GREETING_DELAY_S)
            except asyncio.TimeoutError:
                early = None
            if early == b"":
                return
            if early is not None:                  # клиент старого образца: сразу байты прибора
                try:
                    port = self.resolve("auto")
                    streams = await self.open(port)
                except BridgeError as e:
                    log.warning("Отказ %s (подключение без приветствия): %s", _peer(writer), e)
                    return
                await self._pump(port, streams, reader, writer, early)
                return
            writer.write(_line({"bridge": "carbus", "version": PROTOCOL_VERSION}))
            await writer.drain()
            raw = await asyncio.wait_for(reader.readline(), COMMAND_TIMEOUT_S)
            cmd, _, arg = raw.decode("utf-8", "replace").strip().partition(" ")
            if cmd == "LIST":
                writer.write(_line({"ok": True, "ports": self.ports()}))
                await writer.drain()
            elif cmd == "OPEN":
                try:
                    port = self.resolve(arg.strip())
                    streams = await self.open(port)
                except BridgeError as e:
                    log.warning("Отказ %s: %s", _peer(writer), e)
                    writer.write(_line({"ok": False, "error": str(e)}))
                    await writer.drain()
                    return
                await self._pump(port, streams, reader, writer, reply={"ok": True, "port": {**port, "busy": True}})
            else:
                writer.write(_line({"ok": False, "error": f"неизвестная команда: {cmd or '—'}"}))
                await writer.drain()
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, OSError, ValueError):
            pass                                   # клиент ушёл или молчит
        finally:
            writer.close()

    async def _pump(self, port: dict[str, Any], streams: Streams, reader: asyncio.StreamReader,
                    writer: asyncio.StreamWriter, early: bytes = b"", reply: dict[str, Any] | None = None) -> None:
        serial_r, serial_w = streams
        log.info("Подключение %s → %s", _peer(writer), label(port))
        try:
            if reply is not None:
                writer.write(_line(reply))
                await writer.drain()
            if early:
                serial_w.write(early)
            tasks = {asyncio.ensure_future(_copy(reader, serial_w)), asyncio.ensure_future(_copy(serial_r, writer))}
            try:
                _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (ConnectionError, OSError):
            pass
        finally:
            serial_w.close()
            try:   # порт освобождается, когда файл действительно закрыт: иначе следующее
                   # подключение не получит эксклюзивную блокировку
                await asyncio.wait_for(serial_w.wait_closed(), 2.0)
            except Exception:
                pass
            self.busy.discard(port["path"])
            log.info("Отключение: %s", label(port))

    async def watch(self) -> None:
        """Пишет в консоль, когда CAN-Hacker подключили к USB или выдернули."""
        known: dict[str, dict[str, Any]] | None = None
        while True:
            try:
                now = {p["path"]: p for p in self.ports() if selectable(p)}
            except Exception:
                now = known or {}
            if known is not None:
                for path in now.keys() - known.keys():
                    log.info("Подключён по USB: %s", label(now[path]))
                for path in known.keys() - now.keys():
                    log.info("Отключён от USB: %s", label(known[path]))
            known = now
            await asyncio.sleep(WATCH_S)


def startup_report(ports: list[dict[str, Any]]) -> list[str]:
    lines = []
    for p in ports:
        if p.get("forced"):
            lines.append(f"Порт задан вручную (CARBUS_SERIAL): {label(p)}")
        elif p["kind"] == "canhacker":
            fw = f", прошивка {p['firmware']}" if p.get("firmware") else ""
            lines.append(f"Найден {label(p)}{fw}")
        elif p["kind"] == "compatible":
            lines.append(f"Найден совместимый порт (возможно, CAN-Hacker): {label(p)}")
        else:
            lines.append(f"Пропущен (не CAN-Hacker): {p.get('title')} ({p['path']})")
    if not any(selectable(p) for p in ports):
        lines.append("CAN-Hacker пока не найден — подключите его по USB, мост подхватит его без перезапуска.")
    return lines


async def serve(host: str, port: int, forced: str | None = None) -> None:
    bridge = Bridge(forced)
    for line in startup_report(bridge.ports()):
        log.info("%s", line)
    server = await asyncio.start_server(bridge.handle, host, port)
    log.info("Мост слушает %s:%d (бэкенд в Docker ходит через host.docker.internal:%d). Остановить — Ctrl+C.",
             host, port, port)
    if host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("ВНИМАНИЕ: мост слушает %s — не только localhost; держите firewall включённым.", host)
    watcher = asyncio.ensure_future(bridge.watch())
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGHUP):     # kill, закрытый терминал: закрыть порт и выйти
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            pass
    try:
        async with server:
            await stop.wait()
    finally:
        watcher.cancel()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.bridge",
                                     description="Мост CarBUS: CAN-Hacker по USB ↔ TCP для бэкенда в Docker")
    parser.add_argument("--host", default="127.0.0.1", help="адрес (по умолчанию 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"порт (по умолчанию {DEFAULT_PORT})")
    parser.add_argument("--serial", default=os.environ.get("CARBUS_SERIAL") or None,
                        help="открывать этот порт, даже если он не похож на CAN-Hacker")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    try:
        asyncio.run(serve(args.host, args.port, args.serial))
        log.info("Мост остановлен")
    except KeyboardInterrupt:
        log.info("Мост остановлен")
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        log.error("Порт %s:%d уже занят: мост уже запущен или порт держит другая программа. "
                  "Возьмите другой порт: ./run-bridge.sh %d — и укажите его в «Настройках устройства» → «Дополнительно».",
                  args.host, args.port, args.port + 1)
        return 1
    return 0


# ------------------------------------------------------------- клиент (бэкенд)
def _why(e: BaseException) -> str:
    if isinstance(e, ConnectionRefusedError):
        return "соединение отклонено"
    if isinstance(e, asyncio.TimeoutError):
        return "нет ответа"
    return str(e) or e.__class__.__name__


async def _greet(host: str, port: int, timeout: float) -> Streams:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except (OSError, asyncio.TimeoutError) as e:
        raise BridgeDown(_why(e)) from None
    hello: Any = None
    try:
        raw = await asyncio.wait_for(reader.readline(), timeout)
        hello = json.loads(raw) if raw else None
    except (asyncio.TimeoutError, ConnectionError, OSError, ValueError):
        pass
    except BaseException:          # отменили (истёк общий таймаут подключения) — сокет не бросать
        writer.close()
        raise
    if not isinstance(hello, dict) or hello.get("bridge") != "carbus":
        writer.close()
        raise BridgeForeign("нет приветствия моста CarBUS")
    return reader, writer


async def _reply(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, line: str, timeout: float) -> dict[str, Any]:
    try:
        writer.write(line.encode("utf-8") + b"\n")
        await writer.drain()
        raw = await asyncio.wait_for(reader.readline(), timeout)
        reply = json.loads(raw) if raw else None
    except (asyncio.TimeoutError, ConnectionError, OSError, ValueError) as e:
        raise BridgeForeign(f"мост не ответил на {line.split()[0]}: {_why(e)}") from None
    if not isinstance(reply, dict):
        raise BridgeForeign("мост прислал не тот ответ")
    if not reply.get("ok"):
        raise BridgeRefused(str(reply.get("error") or "мост отказал"))
    return reply


async def bridge_list(host: str, port: int, timeout: float = 1.0) -> list[dict[str, Any]]:
    """USB-порты, которые видит мост (каждый — как app.usbports.describe + busy/forced)."""
    reader, writer = await _greet(host, port, timeout)
    try:
        reply = await _reply(reader, writer, "LIST", timeout)
    finally:
        writer.close()
    ports = reply.get("ports")
    if not isinstance(ports, list):
        raise BridgeForeign("мост не прислал список портов")
    return ports


async def bridge_open(host: str, port: int, path: str = "",
                      timeout: float = 3.0) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, dict[str, Any]]:
    """Открыть порт прибора через мост ("" — мост выберет единственный CAN-Hacker сам).
    Дальше по (reader, writer) идёт протокол прибора."""
    reader, writer = await _greet(host, port, timeout)
    try:
        reply = await _reply(reader, writer, f"OPEN {path or 'auto'}", timeout)
    except BaseException:
        writer.close()
        raise
    info = reply.get("port")
    return reader, writer, info if isinstance(info, dict) else {}


if __name__ == "__main__":
    sys.exit(main())
