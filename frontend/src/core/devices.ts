/** Подписи найденных по USB приборов — общие для статусбара (каркас) и «Настроек устройства». */
import { t } from "../i18n/ru";
import type { DeviceEntry, DevicesState } from "./types";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** «CAN-Hacker v3.2 · № 6950 · 2.2.3.57» (чего нет — пропускаем); чужой порт —
 * «LG Monitor Controls (cu.usbmodem506NTBKGE1012)». */
export function deviceLabel(d: DeviceEntry): string {
  if (d.kind === "other") return `${d.title} (${basename(d.path)})`;
  const parts = [d.title, d.serial != null ? t.device.serialNo(d.serial) : "", d.firmware ?? ""];
  return parts.filter(Boolean).join(" · ") || basename(d.path);
}

/** Каким путём бэкенд видит прибор: мост на маке, USB (проброшенный в контейнер) или демо. */
export function deviceVia(d: DeviceEntry, inContainer: boolean): string {
  if (d.source === "bridge") return t.device.via.bridge;
  if (d.source === "usb") return inContainer ? t.device.via.usbContainer : t.device.via.usb;
  return t.device.via.demo;
}

/** Строка списка «Прибор»: подпись — путь. Совместимый только по VID:PID — «возможно,
 * CAN-Hacker»; порт держит не наше подключение (own — ключ прибора из status.device) — «занят». */
export function deviceOption(d: DeviceEntry, inContainer: boolean, own: string): string {
  const maybe = d.kind === "compatible" ? t.device.maybeCanHacker : "";
  const busy = d.busy && d.key !== own ? t.device.busy : "";
  return `${deviceLabel(d)}${maybe} — ${deviceVia(d, inContainer)}${busy}`;
}

/** Приборы, к которым можно подключиться, — в порядке сервера (CAN-Hacker раньше совместимых). */
export function selectableDevices(snap: DevicesState): DeviceEntry[] {
  return snap.devices.filter((d) => d.selectable);
}
