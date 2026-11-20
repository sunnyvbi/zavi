
import { latestDueSlot, nextFire, parseCron, CronError } from "./cron";
import { signInvocation, type ScheduleInvocationMeta } from "./signing";
import type { ClaimedRun, SiteFunctionsStore } from "./store";

export const SCHEDULER = {
  dueBatch: 500,
  dueLeaseS: 60,
  claimBatch: 200,
  runLeaseS: 150,
  siteConcurrency: 2,
  maxAttempts: 5,
  invokeTimeoutMs: 70_000,
  backoffBaseS: 30,
  backoffMaxS: 3600,
  maxCatchUpMs: 60 * 60_000,
} as const;

export interface SchedulerDeps {
  store: SiteFunctionsStore;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
}

export interface InvokeDeps extends SchedulerDeps {
  dispatchUrl: string;
  dispatchSecret: string;
  fetchFn?: typeof fetch;
  random?: () => number;
}

const logOf = (d: SchedulerDeps) => d.log ?? ((l: Record<string, unknown>) => console.log(JSON.stringify(l)));

export async function schedulerTick(deps: SchedulerDeps): Promise<{ fired: number; stale: number; invalid: number; claimed: ClaimedRun[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.store.schedulesDue(now, SCHEDULER.dueBatch, SCHEDULER.dueLeaseS);
  let fired = 0;
  let stale = 0;
  let invalid = 0;
  for (const s of due) {
    try {
      const cron = parseCron(s.cron);
      const expected = new Date(s.next_run_at);
      const from = new Date(Math.max(expected.getTime(), now.getTime() - SCHEDULER.maxCatchUpMs));
      const slot = latestDueSlot(cron, from, now) ?? expected;
      const next = nextFire(cron, now);
      const r = await deps.store.scheduleFire(s.id, s.next_run_at, slot, next, SCHEDULER.maxAttempts);
      if (r === "fired") fired++;
      else stale++;
    } catch (e) {
      invalid++;
      logOf(deps)({ evt: "site_functions", step: "schedule_fire", outcome: e instanceof CronError ? "invalid_cron" : "error", site_id: s.site_id, schedule: s.name, error: (e as Error).message.slice(0, 200) });
    }
  }
  const claimed = await deps.store.runsClaim(now, SCHEDULER.claimBatch, SCHEDULER.runLeaseS, SCHEDULER.siteConcurrency);
  if (due.length || claimed.length) logOf(deps)({ evt: "site_functions", step: "tick", due: due.length, fired, stale, invalid, claimed: claimed.length });
  return { fired, stale, invalid, claimed };
}

export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(SCHEDULER.backoffBaseS * 2 ** Math.max(0, attempt - 1), SCHEDULER.backoffMaxS);
  return Math.round(base * (0.8 + random() * 0.4));
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

export async function invokeRun(deps: InvokeDeps, run: ClaimedRun): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const log = logOf(deps);
  if (!run.hostname) {
    return deps.store.runFinish(run.id, run.attempt, false, null, "site has no hostname", null);
  }
  const meta: ScheduleInvocationMeta = {
    v: 1,
    site_id: run.site_id,
    host: run.hostname.toLowerCase(),
    kind: "schedule",
    name: run.schedule_name,
    request_id: `run-${run.id}-${run.attempt}`,
    user: null,
    scheduled_time: new Date(run.slot).toISOString(),
    idempotency_key: run.idempotency_key,
    attempt: run.attempt,
  };
  const body = Buffer.alloc(0);
  const headers = signInvocation(deps.dispatchSecret, meta, "POST", body, now.getTime());
  let status: number | null = null;
  let error: string | null = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SCHEDULER.invokeTimeoutMs);
  try {
    const res = await (deps.fetchFn ?? fetch)(deps.dispatchUrl, { method: "POST", headers, body, signal: ac.signal });
    status = res.status;
    if (res.status >= 300) {
      const j = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      error = typeof j?.error?.code === "string" ? j.error.code.slice(0, 100) : `http_${res.status}`;
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
  } catch (e) {
    error = (e as Error).name === "AbortError" ? "timeout" : "dispatch_unreachable";
  } finally {
    clearTimeout(timer);
  }
  const ok = status !== null && status >= 200 && status < 300;
  const retry = !ok && (status === null || retryable(status)) && run.attempt < run.max_attempts;
  const retryAt = retry ? new Date(now.getTime() + backoffSeconds(run.attempt, deps.random) * 1000) : null;
  const state = await deps.store.runFinish(run.id, run.attempt, ok, status, ok ? null : error, retryAt);
  const line = { evt: "site_functions", step: "run", run_id: run.id, site_id: run.site_id, schedule: run.schedule_name, attempt: run.attempt, status, outcome: state, error };
  if (state === "dead") {
    log({ ...line, alert: "site_function_run_dead" });
  } else log(line);
  return state;
}

export interface RunRef {
  id: string;
  attempt: number;
}

export async function invokeRuns(deps: InvokeDeps, refs: readonly RunRef[], parallel = 10): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let i = 0;
  const worker = async () => {
    while (i < refs.length) {
      const ref = refs[i++];
      let state: string;
      const run = { id: String(ref?.id ?? ""), attempt: Number(ref?.attempt) } as ClaimedRun;
      try {
        const leased = /^[0-9a-f-]{36}$/.test(run.id) && Number.isInteger(run.attempt)
          ? await deps.store.runLeased(run.id, run.attempt, (deps.now ?? (() => new Date()))())
          : null;
        state = leased ? await invokeRun(deps, leased) : "not_leased";
      } catch (e) {
        state = "finish_failed";
        logOf(deps)({ evt: "site_functions", step: "run", run_id: run.id, outcome: "finish_failed", error: (e as Error).message.slice(0, 200) });
      }
      counts[state] = (counts[state] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, refs.length) }, worker));
  return counts;
}
