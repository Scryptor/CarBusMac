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
