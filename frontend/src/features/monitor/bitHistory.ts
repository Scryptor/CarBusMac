/** История бит одного сообщения для битовой карты: для каждого бита (байт × позиция,
 * старший первым — x80…x01) момент последнего переключения. Первые данные и новые
 * байты не подсвечиваются — сравнивать не с чем. */
export class BitHistory {
  private prev: number[] | null = null;
  private starts: number[][] = [];

  update(bytes: number[], now: number): void {
    while (this.starts.length < bytes.length) this.starts.push(Array(8).fill(-Infinity));
    if (this.prev) {
      for (let i = 0; i < bytes.length && i < this.prev.length; i++) {
        const x = (this.prev[i] ^ bytes[i]) & 0xff;
        if (!x) continue;
        for (let pos = 0; pos < 8; pos++) if ((x >> (7 - pos)) & 1) this.starts[i][pos] = now;
      }
    }
    this.prev = bytes.slice();
  }

  start(byte: number, pos: number): number {
    return this.starts[byte]?.[pos] ?? -Infinity;
  }

  lit(now: number, holdMs: number): boolean[][] {
    return this.starts.map((row) => row.map((st) => now - st < holdMs));
  }
}
