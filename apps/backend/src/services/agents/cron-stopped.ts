

export const SCHEDULED_AGENTS_ALLOWED: ReadonlySet<string> = new Set<string>([]);

export const SCHEDULED_WORKERS_ALLOWED: ReadonlySet<string> = new Set<string>([
  "cgo-daily-check",
  "goal-reconcile",
  "ad-budget-reconcile",
  "email-results-check",
  "x-organic-trials",
  "email-plan-tick",
  "live-stunt-snapshot",
  "live-stunt-draft",
  "cgo-budget-review",
  "ad-spend-controller",
  "onboarding-email-sweep",
  "first-plan-watch",
]);

export function cronStopBypassed(): boolean {
  return process.env.PRAXIS_DISABLE_CRON_STOP === "1";
}

export function isCronStopped(slug: string): boolean {
  if (cronStopBypassed()) return false;
  return !SCHEDULED_AGENTS_ALLOWED.has(slug);
}

export function isStandingOrderRow(payload_template: unknown): boolean {
  if (!payload_template || typeof payload_template !== "object") return false;
  const so = (payload_template as Record<string, unknown>).standing_order;
  return !!so && typeof so === "object";
}

export function isWorkerCronStopped(worker: string): boolean {
  if (cronStopBypassed()) return false;
  return !SCHEDULED_WORKERS_ALLOWED.has(worker);
}
