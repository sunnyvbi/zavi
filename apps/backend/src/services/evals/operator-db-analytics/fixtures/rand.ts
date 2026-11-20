
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function daysBefore(anchor: Date, days: number, hourUtc: number, minute = 0): Date {
  const d = new Date(anchor.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d > anchor ? anchor : d;
}
