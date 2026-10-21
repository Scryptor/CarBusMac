import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WsClient, parseEvent } from "../src/core/ws";

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.last = null;
});
afterEach(() => vi.useRealTimers());

function client() {
  const c = new WsClient("ws://x/ws", (u) => new FakeSocket(u) as unknown as WebSocket);
  c.connect();
  const s = FakeSocket.last!;
  s.open();
  return { c, s };
}

test("parseEvent rejects malformed json and missing type", () => {
  expect(() => parseEvent("{bad")).toThrow();
  expect(() => parseEvent('{"a":1}')).toThrow();
  expect(parseEvent('{"type":"status"}').type).toBe("status");
});

test("request resolves on matching reply and rejects on ok:false", async () => {
  const { c, s } = client();
  const p1 = c.request<{ x: number }>({ type: "a" });
  const p2 = c.request({ type: "b" });
  const [m1, m2] = s.sent.map((x) => JSON.parse(x));
  expect(m1.type).toBe("a");
  s.recv({ type: "reply", req_id: m2.req_id, ok: false, error: "плохо" });
  s.recv({ type: "reply", req_id: m1.req_id, ok: true, data: { x: 5 } });
  await expect(p1).resolves.toEqual({ x: 5 });
  await expect(p2).rejects.toThrow("плохо");
});

test("request times out", async () => {
  const { c } = client();
  const p = c.request({ type: "slow" }, 1000);
  vi.advanceTimersByTime(1001);
  await expect(p).rejects.toThrow(/время/);
});

test("dispatches events by type and unsubscribes", () => {
  const { c, s } = client();
  const got: string[] = [];
  const off = c.on("status", (e) => got.push(String(e.state)));
  s.recv({ type: "status", state: "opened" });
  s.recv({ type: "other" });
  off();
  s.recv({ type: "status", state: "closed" });
  expect(got).toEqual(["opened"]);
});

test("queues sends until open and tracks state", () => {
  const c = new WsClient("ws://x/ws", (u) => new FakeSocket(u) as unknown as WebSocket);
  c.connect();
  const s = FakeSocket.last!;
  expect(c.state.value).toBe("connecting");
  c.send({ type: "early" });
  expect(s.sent).toEqual([]);
  s.open();
  expect(c.state.value).toBe("open");
  expect(JSON.parse(s.sent[0]).type).toBe("early");
});

test("reconnects with backoff after close and rejects pending requests", async () => {
  const { c, s } = client();
  const p = c.request({ type: "x" });
  s.close();
  await expect(p).rejects.toThrow(/связи/);
  expect(c.state.value).toBe("closed");
  const first = FakeSocket.last;
  vi.advanceTimersByTime(260);
  expect(FakeSocket.last).not.toBe(first);
  FakeSocket.last!.close();
  const second = FakeSocket.last;
  vi.advanceTimersByTime(300);
  expect(FakeSocket.last).toBe(second); // вторая пауза длиннее (500 мс)
  vi.advanceTimersByTime(300);
  expect(FakeSocket.last).not.toBe(second);
});

// команды на CAN-шину: то, что пользователю уже показали как ошибку, не должно уйти позже
test("a request made while connecting is sent once the socket opens", async () => {
  const c = new WsClient("ws://x/ws", (u) => new FakeSocket(u) as unknown as WebSocket);
  c.connect();
  const s = FakeSocket.last!;
  const p = c.request<{ n: number }>({ type: "early" });
  expect(s.sent).toEqual([]);
  s.open();
  const m = JSON.parse(s.sent[0]);
  expect(m.type).toBe("early");
  s.recv({ type: "reply", req_id: m.req_id, ok: true, data: { n: 1 } });
  await expect(p).resolves.toEqual({ n: 1 });
});

test("a request that timed out while connecting is not sent when the socket opens", async () => {
  const c = new WsClient("ws://x/ws", (u) => new FakeSocket(u) as unknown as WebSocket);
  c.connect();
  const s = FakeSocket.last!;
  const p = c.request({ type: "tx_send" }, 1000);
  vi.advanceTimersByTime(1001);
  await expect(p).rejects.toThrow(/время/);
  s.open();
  expect(s.sent).toEqual([]);
});

test("requests queued for a failed connection attempt are rejected and dropped", async () => {
  const c = new WsClient("ws://x/ws", (u) => new FakeSocket(u) as unknown as WebSocket);
  c.connect();
  const s = FakeSocket.last!;
  const p = c.request({ type: "tx_send" });
  s.close(); // попытка подключения не удалась
  await expect(p).rejects.toThrow(/связи/);
  vi.advanceTimersByTime(260);
  const s2 = FakeSocket.last!;
  expect(s2).not.toBe(s);
  s2.open();
  expect(s2.sent).toEqual([]);
});

test("with no connection a request fails at once and is never sent after reconnect", async () => {
  const { c, s } = client();
  s.close(); // связь пропала; новая попытка — через паузу
  const errors: string[] = [];
  for (let k = 0; k < 3; k++) c.request({ type: "tx_send" }).catch((e: Error) => errors.push(e.message));
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).toEqual(["Нет связи с сервером", "Нет связи с сервером", "Нет связи с сервером"]);
  vi.advanceTimersByTime(260);
  FakeSocket.last!.open();
  expect(FakeSocket.last!.sent).toEqual([]);
});
