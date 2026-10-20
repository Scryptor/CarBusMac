/** WebSocket-клиент протокола v2: события по типам, команды с ответом по req_id,
 * очередь отправки до открытия сокета и автопереподключение с нарастающей паузой.
 * Сам сокет создаётся фабрикой — в тестах подменяется фейком. */
import { signal } from "@preact/signals";
import { t } from "../i18n/ru";

export type ConnState = "connecting" | "open" | "closed";

export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

export type EventHandler = (e: ServerEvent) => void;

export function parseEvent(raw: string): ServerEvent {
  const obj: unknown = JSON.parse(raw);
  if (typeof obj !== "object" || obj === null || typeof (obj as { type?: unknown }).type !== "string") {
    throw new Error("event has no string 'type'");
  }
  return obj as ServerEvent;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const BACKOFF_MIN = 250;
const BACKOFF_MAX = 5000;

export class WsClient {
  readonly state = signal<ConnState>("closed");
  private ws?: WebSocket;
  private handlers = new Map<string, Set<EventHandler>>();
  private pending = new Map<number, Pending>();
  private queue: string[] = [];
  private seq = 0;
  private backoff = BACKOFF_MIN;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(
    private url: string,
    private makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  connect(): void {
    this.stopped = false;
    this.state.value = "connecting";
    const ws = this.makeSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.state.value = "open";
      this.backoff = BACKOFF_MIN;
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev: MessageEvent) => this.onMessage(String(ev.data));
    ws.onclose = () => this.onClose(ws);
  }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  on(type: string, fn: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  send(cmd: Record<string, unknown>): void {
    const raw = JSON.stringify(cmd);
    if (this.ws && this.state.value === "open") this.ws.send(raw);
    else this.queue.push(raw);
  }

  request<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    const reqId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(t.err.timeout));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.send({ ...cmd, req_id: reqId });
    });
  }

  private onMessage(raw: string): void {
    let e: ServerEvent;
    try {
      e = parseEvent(raw);
    } catch {
      return;
    }
    if (e.type === "reply") {
      const p = this.pending.get(Number(e.req_id));
      if (!p) return;
      this.pending.delete(Number(e.req_id));
      clearTimeout(p.timer);
      if (e.ok) p.resolve(e.data);
      else p.reject(new Error(String(e.error ?? t.err.generic)));
      return;
    }
    for (const h of this.handlers.get(e.type) ?? []) h(e);
    for (const h of this.handlers.get("*") ?? []) h(e);
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.state.value = "closed";
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(t.status.server.closed));
      this.pending.delete(id);
    }
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.retry = setTimeout(() => this.connect(), delay);
  }
}
