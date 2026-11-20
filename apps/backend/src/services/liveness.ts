
const DEFAULT_LAG_CEILING_MS = 60_000;

const SAMPLE_INTERVAL_MS = 1_000;

let lastTickAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

export function currentEventLoopLagMs(): number {
  const sinceTick = Date.now() - lastTickAt;
  return Math.max(0, sinceTick - SAMPLE_INTERVAL_MS);
}

export interface Liveness {
  ok: boolean;
  uptime_s: number;
  event_loop_lag_ms: number;
}

export function getLiveness(
  lagCeilingMs: number = DEFAULT_LAG_CEILING_MS,
): Liveness {
  const lag = currentEventLoopLagMs();
  return {
    ok: lag < lagCeilingMs,
    uptime_s: process.uptime(),
    event_loop_lag_ms: lag,
  };
}

export function startLivenessSampler(): void {
  if (timer) return;
  lastTickAt = Date.now();
  timer = setInterval(() => {
    lastTickAt = Date.now();
  }, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function _stopLivenessSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastTickAt = Date.now();
}

export function _setLastTickForTest(at: number): void {
  lastTickAt = at;
}
