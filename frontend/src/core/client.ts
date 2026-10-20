/** Единственный WS-клиент приложения (тот же origin, путь /ws). */
import { WsClient } from "./ws";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export const client = new WsClient(wsUrl());

/** Команда с ответом; ошибки сервера превращаются в исключение с русским текстом. */
export function cmd<T = unknown>(type: string, args: Record<string, unknown> = {}): Promise<T> {
  return client.request<T>({ type, ...args });
}
