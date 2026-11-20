
import { apiUrl } from "@/lib/api";

export const LIVE_STATS_PATH = "/api/public/live-stats";
export const LIVE_STATS_STORAGE_KEY = "zavi.liveStats";

export type LiveMetricKey = "tokens_processed" | "agent_steps";

export type LiveMetric = { value: number; rate_per_sec: number };

export type LiveStatsPayload = {
  as_of: string;
  metrics: Record<LiveMetricKey, LiveMetric>;
};

export type LiveStatsState = { payload: LiveStatsPayload; frozen: boolean } | null;

const METRIC_KEYS: readonly LiveMetricKey[] = ["tokens_processed", "agent_steps"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMetric(v: unknown): LiveMetric | null {
  if (!isRecord(v)) return null;
  const { value, rate_per_sec } = v;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (typeof rate_per_sec !== "number" || !Number.isFinite(rate_per_sec) || rate_per_sec < 0) return null;
  return { value, rate_per_sec };
}

export function parseLiveStats(raw: unknown): LiveStatsPayload | null {
  if (!isRecord(raw) || typeof raw.as_of !== "string") return null;
  if (!Number.isFinite(Date.parse(raw.as_of))) return null;
  if (!isRecord(raw.metrics)) return null;
  const metrics = {} as Record<LiveMetricKey, LiveMetric>;
  for (const key of METRIC_KEYS) {
    const m = parseMetric(raw.metrics[key]);
    if (!m) return null;
    metrics[key] = m;
  }
  return { as_of: raw.as_of, metrics };
}

export function readStoredLiveStats(): LiveStatsPayload | null {
  try {
    const raw = window.localStorage.getItem(LIVE_STATS_STORAGE_KEY);
    if (!raw) return null;
    return parseLiveStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeStoredLiveStats(payload: LiveStatsPayload): void {
  try {
    const stored = readStoredLiveStats();
    if (stored && Date.parse(stored.as_of) > Date.parse(payload.as_of)) return;
    window.localStorage.setItem(LIVE_STATS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
}

export const LIVE_STATS_TIMEOUT_MS = 15_000;

export async function fetchLiveStats(fetchImpl: typeof fetch = fetch): Promise<LiveStatsState> {
  const ctrl = new AbortController();
  const deadline = setTimeout(() => ctrl.abort(), LIVE_STATS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(apiUrl(LIVE_STATS_PATH), { cache: "no-store", signal: ctrl.signal });
    if (res.ok) {
      const payload = parseLiveStats(await res.json());
      if (payload) {
        writeStoredLiveStats(payload);
        return { payload, frozen: false };
      }
    }
  } catch {
  } finally {
    clearTimeout(deadline);
  }
  const stored = readStoredLiveStats();
  return stored ? { payload: stored, frozen: true } : null;
}

export const MAX_PROJECTION_SEC = 3600;

export const LIVE_STATS_REFRESH_MS = 5 * 60 * 1000;

export function displayValue(state: LiveStatsState, metric: LiveMetricKey, nowMs: number): number | null {
  if (!state) return null;
  const m = state.payload.metrics[metric];
  let v = m.value;
  if (!state.frozen) {
    const elapsedSec = Math.min(
      MAX_PROJECTION_SEC,
      Math.max(0, (nowMs - Date.parse(state.payload.as_of)) / 1000),
    );
    v += m.rate_per_sec * elapsedSec;
  }
  return Math.floor(v);
}

export class MonotonicClamp {
  private high: Partial<Record<LiveMetricKey, number>> = {};

  apply(metric: LiveMetricKey, value: number): number {
    const prev = this.high[metric];
    const next = prev === undefined ? value : Math.max(prev, value);
    this.high[metric] = next;
    return next;
  }

  reset(): void {
    this.high = {};
  }
}

export const liveStatsClamp = new MonotonicClamp();

let current: LiveStatsState = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let settled = false;
let lastPullAt = 0;

function publish(next: LiveStatsState): void {
  liveStatsClamp.reset();
  current = next;
  listeners.forEach((l) => l());
}

function freezeCurrent(): void {
  if (current && !current.frozen) publish({ payload: current.payload, frozen: true });
}

function take(next: LiveStatsState): void {
  if (next === null) {
    freezeCurrent();
    return;
  }
  if (current && Date.parse(next.payload.as_of) < Date.parse(current.payload.as_of)) {
    if (next.frozen) freezeCurrent();
    return;
  }
  publish(next);
}

async function pull(): Promise<void> {
  if (busy) return;
  busy = true;
  lastPullAt = Date.now();
  try {
    take(await fetchLiveStats());
  } finally {
    busy = false;
    if (!settled) {
      settled = true;
      listeners.forEach((l) => l());
    }
  }
}

function seedFromStorage(): void {
  if (current) return;
  const stored = readStoredLiveStats();
  if (stored) publish({ payload: stored, frozen: true });
}

export function prefetchLiveStats(): void {
  seedFromStorage();
  if (!current || current.frozen) void pull();
}

export function subscribeLiveStats(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    seedFromStorage();
    if (Date.now() - lastPullAt > 60_000) void pull();
    timer = setInterval(() => void pull(), LIVE_STATS_REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getLiveStatsSnapshot(): LiveStatsState {
  return current;
}

export function getLiveStatsSettled(): boolean {
  return settled;
}

export function resetLiveStatsForTests(): void {
  current = null;
  listeners.clear();
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
  settled = false;
  lastPullAt = 0;
  liveStatsClamp.reset();
}

const FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(n: number): string {
  return FORMAT.format(n);
}
