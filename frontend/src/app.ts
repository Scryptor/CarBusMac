/** Единая точка: WebSocket-клиент к бэкенду (тот же origin, путь /ws). */
import { WsClient } from "./ws";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export const client = new WsClient(wsUrl());
