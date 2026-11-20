
export type Resolution =
  | { weight: number; resolved_to: "correct" }
  | { weight: number; resolved_to: "incorrect" }
  | { weight: number; resolved_to: "partial" }
  | { weight: number; resolved_to: null };

export type CalibrationBucket = {
  bucket: string;
  n: number;
  actual_rate: number;
};

export type ScorecardMetrics = {
  brier: number | null;
  brier_n: number;
  directional_accuracy: number | null;
  directional_accuracy_n: number;
  actual_rate: number | null;
  actual_rate_n: number;
  calibration_curve: CalibrationBucket[];
};

export function roundWeight(w: number): number {
  if (!Number.isFinite(w)) {
    throw new Error(`roundWeight: non-finite weight ${w}`);
  }
  const clamped = Math.max(0, Math.min(1, w));
  return Math.round(clamped * 20) / 20;
}

export function brierScore(resolutions: Resolution[]): { brier: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of resolutions) {
    if (r.resolved_to === "correct") {
      sum += (r.weight - 1) ** 2;
      n++;
    } else if (r.resolved_to === "incorrect") {
      sum += r.weight ** 2;
      n++;
    }
  }
  if (n === 0) return { brier: null, n: 0 };
  return { brier: sum / n, n };
}

export function directionalAccuracy(resolutions: Resolution[]): { value: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of resolutions) {
    if (r.resolved_to === null) continue;
    if (r.resolved_to === "partial") {
      sum += 0.5;
      n++;
      continue;
    }
    const predicted_yes = r.weight >= 0.5;
    const actual_yes = r.resolved_to === "correct";
    sum += predicted_yes === actual_yes ? 1 : 0;
    n++;
  }
  if (n === 0) return { value: null, n: 0 };
  return { value: sum / n, n };
}

export function actualRate(resolutions: Resolution[]): { value: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of resolutions) {
    if (r.resolved_to === null) continue;
    if (r.resolved_to === "correct") sum += 1;
    else if (r.resolved_to === "partial") sum += 0.5;
    n++;
  }
  if (n === 0) return { value: null, n: 0 };
  return { value: sum / n, n };
}

const BUCKET_EDGES: Array<[number, number, string]> = [
  [0.0, 0.1, "0.0-0.1"],
  [0.1, 0.2, "0.1-0.2"],
  [0.2, 0.3, "0.2-0.3"],
  [0.3, 0.4, "0.3-0.4"],
  [0.4, 0.5, "0.4-0.5"],
  [0.5, 0.6, "0.5-0.6"],
  [0.6, 0.7, "0.6-0.7"],
  [0.7, 0.8, "0.7-0.8"],
  [0.8, 0.9, "0.8-0.9"],
  [0.9, 1.0, "0.9-1.0"],
];

export function calibrationCurve(resolutions: Resolution[]): CalibrationBucket[] {
  const counts = BUCKET_EDGES.map(() => ({ n: 0, correct: 0 }));
  for (const r of resolutions) {
    if (r.resolved_to === "partial" || r.resolved_to === null) continue;
    let idx = -1;
    for (let i = 0; i < BUCKET_EDGES.length; i++) {
      const [lo, hi] = BUCKET_EDGES[i];
      const isLast = i === BUCKET_EDGES.length - 1;
      if (r.weight >= lo && (isLast ? r.weight <= hi : r.weight < hi)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    counts[idx].n++;
    if (r.resolved_to === "correct") counts[idx].correct++;
  }
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < BUCKET_EDGES.length; i++) {
    if (counts[i].n === 0) continue;
    out.push({
      bucket: BUCKET_EDGES[i][2],
      n: counts[i].n,
      actual_rate: counts[i].correct / counts[i].n,
    });
  }
  return out;
}

export function computeScorecardMetrics(resolutions: Resolution[]): ScorecardMetrics {
  const b = brierScore(resolutions);
  const d = directionalAccuracy(resolutions);
  const a = actualRate(resolutions);
  return {
    brier: b.brier,
    brier_n: b.n,
    directional_accuracy: d.value,
    directional_accuracy_n: d.n,
    actual_rate: a.value,
    actual_rate_n: a.n,
    calibration_curve: calibrationCurve(resolutions),
  };
}
