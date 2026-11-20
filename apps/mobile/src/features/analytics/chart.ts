
export type Unit = string | undefined;

export const round2 = (n: number) => Math.round(n * 100) / 100;

function niceStep(target: number): number {
  let step = 1;
  if (target > 0) {
    const base = 10 ** Math.floor(Math.log10(target));
    step = 10 * base;
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (m * base >= target) {
        step = m * base;
        break;
      }
    }
  }
  return step;
}

export function niceScale(values: number[]): { step: number; top: number; bottom: number } {
  const finite = values.filter(Number.isFinite);
  const max = finite.length ? Math.max(...finite) : 0;
  const min = finite.length ? Math.min(...finite) : 0;
  if (min >= 0) {
    const step = niceStep(Math.max(0, max) / 4);
    return { step, top: 4 * step, bottom: 0 };
  }
  const step = niceStep((max - min) / 4);
  const top = Math.max(0, Math.ceil(max / step) * step);
  const bottom = Math.min(0, Math.floor(min / step) * step);
  return { step, top, bottom };
}

export function axisLabel(n: number, unit: Unit): string {
  const body = Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : String(round2(n));
  return unit === "$" ? `$${body}` : unit ? `${body}${unit}` : body;
}

export function tipValue(n: number | null, unit: Unit): string {
  if (n === null) return "—";
  const body =
    Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(round2(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return unit === "$" ? `$${body}` : unit === "%" ? `${n}%` : unit ? `${body}${unit}` : body;
}

export type Pt = { x: number; y: number };

export function monotonePath(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0].x} ${pts[0].y}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const t = new Array<number>(n).fill(0);
  t[0] = slope[0];
  t[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * slope[i];
      t[i + 1] = k * b * slope[i];
    }
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = round2(pts[i].x + dx[i] / 3);
    const c1y = round2(pts[i].y + (t[i] * dx[i]) / 3);
    const c2x = round2(pts[i + 1].x - dx[i] / 3);
    const c2y = round2(pts[i + 1].y - (t[i + 1] * dx[i]) / 3);
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}

export function labelEvery(count: number, plotWidth: number, minGap: number): number {
  return Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / minGap))));
}
