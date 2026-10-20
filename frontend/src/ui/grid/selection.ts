/** Выделение строк как в таблицах десктопа: клик — одна строка, Shift — диапазон от
 * якоря, Ctrl/Cmd — добавить/убрать строку; стрелки двигают фокус (с Shift — расширяют). */
export class Selection {
  private items = new Set<number>();
  anchor: number | null = null;
  focus: number | null = null;

  click(i: number): void {
    this.items = new Set([i]);
    this.anchor = this.focus = i;
  }

  shiftClick(i: number): void {
    const a = this.anchor ?? i;
    this.items = new Set();
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) this.items.add(k);
    this.anchor = a;
    this.focus = i;
  }

  ctrlClick(i: number): void {
    if (this.items.has(i)) this.items.delete(i);
    else this.items.add(i);
    this.anchor = this.focus = i;
  }

  /** Добавить строки к выделению («Выделить сообщения» по ID) — курсор не двигается. */
  addMany(list: number[]): void {
    for (const i of list) this.items.add(i);
  }

  removeMany(list: number[]): void {
    for (const i of list) this.items.delete(i);
  }

  move(delta: number, total: number, extend: boolean): void {
    if (total <= 0) return;
    const from = this.focus ?? (delta > 0 ? -1 : total);
    const to = Math.min(total - 1, Math.max(0, from + delta));
    if (extend) this.shiftClick(to);
    else this.click(to);
  }

  has(i: number): boolean {
    return this.items.has(i);
  }

  selected(): number[] {
    return [...this.items].sort((a, b) => a - b);
  }

  get size(): number {
    return this.items.size;
  }

  clamp(total: number): void {
    for (const i of [...this.items]) if (i >= total) this.items.delete(i);
    if (this.anchor != null && this.anchor >= total) this.anchor = total > 0 ? total - 1 : null;
    if (this.focus != null && this.focus >= total) this.focus = total > 0 ? total - 1 : null;
  }

  clear(): void {
    this.items.clear();
    this.anchor = this.focus = null;
  }
}
