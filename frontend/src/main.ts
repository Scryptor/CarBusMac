/** Композиционный корень фронта: полоса подключения и панель device info.
 * Экраны монитора/потока/передачи/фильтров/трейсера подключаются в FE-2..FE-5. */
import { client } from "./app";
import type { ServerEvent } from "./ws";
import { initMonitor } from "./monitor";
import { initBitmap } from "./bitmap";
import "./style.css";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
}

let connected = false;

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
}

function renderInfo(info: Record<string, unknown> | undefined): void {
  const box = el("deviceInfo");
  if (!info) {
    box.textContent = "";
    return;
  }
  const keys = ["hardware_name", "firmware_version", "serial_int", "channel_types", "features_mask"];
  box.innerHTML = keys
    .filter((k) => info[k] !== undefined)
    .map((k) => `<span class="kv"><b>${k}</b> ${escapeHtml(JSON.stringify(info[k]))}</span>`)
    .join("");
}

function initConnect(): void {
  const host = el<HTMLInputElement>("bridgeHost");
  const port = el<HTMLInputElement>("bridgePort");
  const btn = el<HTMLButtonElement>("btnConnect");
  const status = el("connStatus");

  client.on("status", (e: ServerEvent) => {
    connected = Boolean(e.connected);
    status.textContent = (connected ? "● " : "○ ") + String(e.message ?? "");
    status.className = connected ? "ok" : "off";
    btn.textContent = connected ? "Disconnect" : "Connect";
  });
  client.on("device_info", (e: ServerEvent) => renderInfo(e.info as Record<string, unknown>));
  client.on("error", (e: ServerEvent) => {
    status.textContent = "error: " + String(e.message);
    status.className = "off";
  });

  btn.addEventListener("click", () => {
    if (!connected) {
      client.send({ type: "connect", bridge_host: host.value, bridge_port: Number(port.value) });
    } else {
      client.send({ type: "disconnect" });
    }
  });
}

function initTabs(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#receive .tabbar button");
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.dataset.tab;
      buttons.forEach((x) => x.classList.toggle("active", x === b));
      document
        .querySelectorAll<HTMLElement>("#receive .tab")
        .forEach((t) => t.classList.toggle("active", t.id === tab));
    });
  });
}

initConnect();
initBitmap();
initMonitor();
initTabs();
client.connect();
