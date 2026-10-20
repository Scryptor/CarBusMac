/** Кэш строк потока/трейса для виртуальной таблицы: строки живут на бэкенде, фронт
 * держит страницы вокруг видимой области и «хвост», который сервер присылает каждый тик. */
import type { FrameRowJson } from "../../core/types";

export class StreamCache<R extends { i: number } = FrameRowJson> {
  private rows = new Map<number, R>();
  private pending = new Set<number>();

  constructor(readonly pageSize = 200) {}

  get(i: number): R | undefined {
    return this.rows.get(i);
  }

  private complete(page: number, total?: number): boolean {
    const start = page * this.pageSize;
    const end = Math.min((page + 1) * this.pageSize, total ?? (page + 1) * this.pageSize);
    for (let i = start; i < end; i++) if (!this.rows.has(i)) return false;
    return true;
  }

  /** Страницы диапазона [first, last), которых нет в кэше и которые ещё не запрошены. */
  missingPages(first: number, last: number, total?: number): number[] {
    const out: number[] = [];
    if (last <= first) return out;
    for (let p = Math.floor(first / this.pageSize); p <= Math.floor((last - 1) / this.pageSize); p++) {
      if (this.pending.has(p) || this.complete(p, total)) continue;
      out.push(p);
    }
    return out;
  }

  markPending(page: number): void {
    this.pending.add(page);
  }

  clearPending(page: number): void {
    this.pending.delete(page);
  }

  put(start: number, rows: R[]): void {
    rows.forEach((r, k) => this.rows.set(start + k, r));
  }

  applyTail(start: number, rows: R[]): void {
    this.put(start, rows);
  }

  /** Держим кэш ограниченным: выбрасываем строки далеко от видимой области. */
  trim(keepFrom: number, keepTo: number, max = 20000): void {
    if (this.rows.size <= max) return;
    for (const i of this.rows.keys()) if (i < keepFrom || i >= keepTo) this.rows.delete(i);
  }

  reset(): void {
    this.rows.clear();
    this.pending.clear();
  }
}
