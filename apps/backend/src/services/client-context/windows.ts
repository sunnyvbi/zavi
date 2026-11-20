export function resolveWindows(
  now: Date,
  windowDays: number,
): {
  window: { since: string; until: string; days: number };
  previous_window: { since: string; until: string };
} {
  const untilMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dayMs = 24 * 60 * 60 * 1000;
  const sinceMs = untilMs - windowDays * dayMs;
  const prevSinceMs = sinceMs - windowDays * dayMs;
  return {
    window: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      days: windowDays,
    },
    previous_window: {
      since: new Date(prevSinceMs).toISOString(),
      until: new Date(sinceMs).toISOString(),
    },
  };
}
