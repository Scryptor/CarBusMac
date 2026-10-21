/** Единственный WS-клиент приложения (тот же origin, путь /ws). */
import { WsClient } from "./ws";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export const client = new WsClient(wsUrl());

/** Команды, которые на больших трейсах (миллионы кадров) или при молчащем мосте идут
 * дольше обычных 10 с; бэкенд выполняет их в фоне и отвечает, когда закончит. */
export const LONG_COMMANDS = new Set(["connect", "capture_save", "capture_load", "capture_to_tracer", "tracer_open", "tracer_save"]);
export const LONG_TIMEOUT_MS = 180_000;

/** Команда с ответом; ошибки сервера превращаются в исключение с русским текстом. */
export function cmd<T = unknown>(type: string, args: Record<string, unknown> = {}): Promise<T> {
  return client.request<T>({ type, ...args }, LONG_COMMANDS.has(type) ? LONG_TIMEOUT_MS : undefined);
}
