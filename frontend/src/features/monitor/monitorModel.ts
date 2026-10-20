/** Строки монитора: по одной на (канал, ID, 11/29 бит), значения обновляются на месте,
 * порядок — по первому появлению (как в десктопе), по желанию — сортировка по ID и
 * группировка по каналам. Здесь же моменты подсветки байтов. */
import { signal } from "@preact/signals";
import type { MonitorRowJson } from "../../core/types";
import { applyChanges, type HighlightSettings } from "./highlight";

export const rowKey = (ch: number, id: number, ext: boolean): string => `${ch}:${id}:${ext ? 1 : 0}`;

export class MonitorStore {
  private rows = new Map<string, MonitorRowJson>();
  private arrival: string[] = [];
  private starts = new Map<string, number[]>();
  readonly version = signal(0);

  get size(): number {
    return this.rows.size;
  }

  get(key: string): MonitorRowJson | undefined {
    return this.rows.get(key);
  }

  marks(key: string): number[] {
    return this.starts.get(key) ?? [];
  }

  /** hs = null — без подсветки (снапшот при подключении вкладки). */
  apply(rows: MonitorRowJson[], now: number, hs: HighlightSettings | null): void {
    for (const r of rows) {
      const key = rowKey(r.ch, r.id, r.ext);
      if (!this.rows.has(key)) this.arrival.push(key);
      this.rows.set(key, r);
      if (hs) this.starts.set(key, applyChanges(this.starts.get(key) ?? [], r.changed, r.stable_ms, now, hs));
    }
    this.version.value++;
  }

  reset(): void {
    this.rows.clear();
    this.arrival = [];
    this.starts.clear();
    this.version.value++;
  }

  order(sort: boolean, group: boolean): string[] {
    const keys = this.arrival.slice();
    if (sort) {
      keys.sort((a, b) => {
        const ra = this.rows.get(a)!;
        const rb = this.rows.get(b)!;
        return ra.id - rb.id || Number(ra.ext) - Number(rb.ext) || ra.ch - rb.ch;
      });
    }
    if (group) keys.sort((a, b) => this.rows.get(a)!.ch - this.rows.get(b)!.ch);
    return keys;
  }

  all(): MonitorRowJson[] {
    return this.arrival.map((k) => this.rows.get(k)!);
  }
}
