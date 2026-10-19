/** Тонкий клиент WebSocket и типы сообщений (зеркало backend/app/schemas.py).
 * parseEvent — чистая функция (без зависимости от WebSocket), тестируется отдельно. */

export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

export function parseEvent(raw: string): ServerEvent {
  const obj: unknown = JSON.parse(raw);
  if (typeof obj !== "object" || obj === null || typeof (obj as { type?: unknown }).type !== "string") {
    throw new Error("event has no string 'type'");
  }
  return obj as ServerEvent;
}

export type EventHandler = (e: ServerEvent) => void;

export class WsClient {
  private ws?: WebSocket;
  private handlers = new Map<string, EventHandler[]>();

  constructor(private url: string) {}

  connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev: MessageEvent) => {
      let e: ServerEvent;
      try {
        e = parseEvent(ev.data as string);
      } catch {
        return;
      }
      for (const h of this.handlers.get(e.type) ?? []) h(e);
    };
  }

  on(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(cmd: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(cmd));
  }
}
