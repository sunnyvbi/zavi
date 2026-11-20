
import { WEEKLY_PLAN_CRON, wallDate, wallLabel } from "./time";
import { draftBlocker, draftVersionOf, type DraftRun } from "./draft-blocker";
import type { EmailRunPreflight } from "./preflight";

export type PlanJob = {
  id: string;
  tenant_id: string;
  item_id: string;
  kind: "draft" | "deadline";
  job_key: string;
  lease_token: string;
  attempts: number;
};

export type OutboxRow = { tenant_id: string; event_id: string; event_name: string; event_data: Record<string, unknown>; created_at: string };
export type ScheduleRow = { tenant_id: string; lease_token: string; timezone: string };
export type PlanEvent = { id: string; name: string; data: Record<string, unknown> };
export type CardRef = { rail: "channel_actions" | "decisions"; id: string; class: string; body: unknown };
export type Unattended = { allow: boolean; count: number | null; reasons: string[] };
export type RunStart = { ok: boolean; run_id?: string | null; reason?: string };
export type DraftItem = { route: string; list_id: string; status: string; card_id: string | null };

export type PassDeps = {
  now: () => Date;
  repair: (limit: number) => Promise<number>;
  alertStuckHolds: (limit: number) => Promise<number>;
  outboxPending: (limit: number) => Promise<OutboxRow[]>;
  claimJobs: (limit: number, leaseSeconds: number) => Promise<PlanJob[]>;
  completeJob: (job: PlanJob, outcome: "done" | "retry", error: string | null, retrySeconds?: number) => Promise<number>;
  rpc: <T>(tenantId: string, name: string, args: Record<string, unknown>) => Promise<T>;
  send: (e: PlanEvent) => Promise<void>;
  unattended: (tenantId: string, card: CardRef) => Promise<Unattended>;
  startRun: (tenantId: string, extra: Record<string, unknown>, requestId: string) => Promise<RunStart>;
  lastDraftRun?: (tenantId: string, itemId: string, version: number) => Promise<DraftRun | null>;
  draftItem?: (tenantId: string, itemId: string) => Promise<DraftItem | null>;
  preflight?: (tenantId: string, plan: { route: string; cards: boolean }) => Promise<EmailRunPreflight>;
  schedulesMissing: (limit: number) => Promise<string[]>;
  claimSchedules: (limit: number) => Promise<ScheduleRow[]>;
  claimZoneChecks: (limit: number) => Promise<ScheduleRow[]>;
  zoneOf: (tenantId: string) => Promise<string | null>;
  nextFire: (tz: string, from: Date) => Date | null;
  weeklyEligible: (tenantId: string) => Promise<boolean | "retry">;
  log: (code: string, message: string, tenantId?: string, level?: "info" | "warn") => void;
};

export const PLAN_PASS = { weeklyRetryMinMs: 15 * 60_000, weeklyRetryMaxMs: 4 * 3_600_000, weeklyRetryWindowMs: 24 * 3_600_000, jobLimit: 25, leaseSeconds: 600, repairLimit: 200, outboxLimit: 50, scheduleLimit: 10, missingLimit: 25, zoneCheckLimit: 25, stuckHoldLimit: 50, budgetMs: 4 * 60_000, draftCheckSeconds: 45 * 60, draftPollSeconds: 4 * 60 };

export type PassReport = { repaired: number; resent: number; jobs: number; drafts: number; deadlines: number; weekly: number; scheduled: number; rezoned: number; stuck_alerted: number; errors: number };

async function emit(deps: PassDeps, tenantId: string, e: PlanEvent): Promise<boolean> {
  try {
    await deps.send(e);
    await deps.rpc(tenantId, "mark_email_plan_outbox_sent", { p_event_id: e.id });
    return true;
  } catch {
    return false;
  }
}

export function genOf(jobKey: string): number | null {
  const m = /:g(\d+)$/.exec(jobKey);
  return m ? Number(m[1]) : null;
}

type FireOut = { ok: boolean; outcome?: "queued" | "skipped" | "noop" | "not_yet"; event?: PlanEvent; reason?: string };

export async function runDeadline(job: PlanJob, deps: PassDeps): Promise<"done" | "retry"> {
  const gen = genOf(job.job_key);
  if (gen === null) return "done";
  const state = await deps.rpc<{ ok: boolean; needs_unattended?: boolean; card?: CardRef | null; schedule_gen?: number }>(job.tenant_id, "email_plan_deadline_state", {
    p_id: job.item_id,
  });
  if (!state.ok || state.schedule_gen !== gen) return "done";
  const unattended: Unattended =
    state.needs_unattended && state.card ? await deps.unattended(job.tenant_id, state.card) : { allow: false, count: null, reasons: [] };
  const out = await deps.rpc<FireOut>(job.tenant_id, "fire_email_planned_send", {
    p_id: job.item_id,
    p_gen: gen,
    p_unattended: { allow: unattended.allow, count: unattended.count, reasons: unattended.reasons.slice(0, 5) },
  });
  if (out.outcome === "not_yet") return "retry";
  if (out.outcome === "queued" && out.event) await emit(deps, job.tenant_id, out.event);
  if (out.outcome === "skipped") deps.log("email_plan.skipped", `planned send skipped: ${out.reason ?? "?"}`, job.tenant_id);
  return "done";
}

type BeginOut = {
  ok: boolean;
  attempt: number | null;
  version?: number;
  route?: string;
  list_id?: string;
  list_name?: string;
  planned_at?: string;
  planned_tz?: string;
  angle?: string;
  why?: string | null;
  reason?: string;
};

type BlockOut = { ok: boolean; blocked?: boolean; reason?: string; status?: string };

async function blockDraft(job: PlanJob, deps: PassDeps, version: number, code: string): Promise<BlockOut | null> {
  const out = await deps
    .rpc<BlockOut>(job.tenant_id, "block_email_plan_draft", {
      p_id: job.item_id,
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_version: version,
      p_code: code,
    })
    .catch(() => null);
  if (out?.ok === true && out.blocked === true) deps.log("email_plan.draft_blocked", `planned draft blocked: ${code}`, job.tenant_id);
  return out;
}

const isBlocked = (out: BlockOut | null) => out?.ok === true && out.blocked === true;

async function stillDrafting(job: PlanJob, deps: PassDeps): Promise<boolean> {
  if (!deps.draftItem) return true;
  return (await deps.draftItem(job.tenant_id, job.item_id))?.status === "drafting";
}

async function lastRunVerdict(job: PlanJob, deps: PassDeps): Promise<"done" | "poll" | null> {
  const version = draftVersionOf(job.job_key);
  if (version === null || !deps.lastDraftRun) return null;
  let run: DraftRun | null;
  try {
    run = await deps.lastDraftRun(job.tenant_id, job.item_id, version);
  } catch {
    return "poll";
  }
  if (!run) return null;
  if (run.status === "queued" || run.status === "running") return "poll";
  if (!(await stillDrafting(job, deps))) return null;
  const code = draftBlocker(run);
  if (code && isBlocked(await blockDraft(job, deps, version, code))) return "done";
  const since = deps.now().getTime() - Date.parse(run.enqueued_at ?? "");
  return since < PLAN_PASS.draftCheckSeconds * 1000 ? "poll" : null;
}

async function heldBeforeRun(job: PlanJob, deps: PassDeps): Promise<"done" | "retry" | null> {
  if (!deps.draftItem || !deps.preflight) return null;
  const item = await deps.draftItem(job.tenant_id, job.item_id);
  if (!item || !["planned", "drafting"].includes(item.status) || item.card_id) return null;
  const pre = await deps.preflight(job.tenant_id, { route: item.route, cards: true });
  if (pre.verdict === "ok") return null;
  if (pre.verdict === "retry") {
    deps.log("email_plan.draft_held", `planned draft waits: ${pre.code}`, job.tenant_id);
    return "retry";
  }
  const version = draftVersionOf(job.job_key);
  const out = version === null ? null : await blockDraft(job, deps, version, pre.code);
  if (isBlocked(out)) return "done";
  if (out?.ok === true && out.reason === undefined && (out.status === "planned" || out.status === "drafting")) {
    deps.log("email_plan.draft_held", `planned draft waits: ${pre.code}`, job.tenant_id);
    return "retry";
  }
  deps.log("email_plan.draft_refused", `planned draft not started: ${pre.code}`, job.tenant_id, "warn");
  return "done";
}

export async function runDraft(job: PlanJob, deps: PassDeps): Promise<"done" | "retry" | "poll"> {
  const verdict = await lastRunVerdict(job, deps);
  if (verdict) return verdict;
  const held = await heldBeforeRun(job, deps);
  if (held) return held;
  const b = await deps.rpc<BeginOut>(job.tenant_id, "begin_email_plan_draft", { p_id: job.item_id, p_job_id: job.id, p_lease_token: job.lease_token });
  if (b.ok && b.reason === "paused") return "retry";
  if (!b.ok || b.attempt === null || b.attempt === undefined) return "done";
  const tz = b.planned_tz ?? "UTC";
  const extra = {
    email_plan: {
      mode: "planned_draft",
      item_id: job.item_id,
      version: b.version,
      route: b.route,
      list_id: b.list_id,
      list_name: b.list_name,
      planned_at: b.planned_at,
      planned_label: b.planned_at ? `${wallLabel(b.planned_at, tz)} (${tz})` : "",
      angle: b.angle,
      why: b.why ?? null,
    },
  };
  const started = await deps.startRun(job.tenant_id, extra, `email-plan-draft:${job.item_id}:v${b.version}:a${b.attempt}`);
  if (!started.ok) deps.log("email_plan.draft_not_started", `planned draft not started: ${started.reason ?? "?"}`, job.tenant_id);
  return started.ok ? "poll" : "retry";
}

async function runJobs(deps: PassDeps, report: PassReport, deadline: number): Promise<void> {
  const jobs = await deps.claimJobs(PLAN_PASS.jobLimit, PLAN_PASS.leaseSeconds);
  for (const job of jobs) {
    if (deps.now().getTime() > deadline) break;
    report.jobs += 1;
    let outcome: "done" | "retry" | "poll";
    let error: string | null = null;
    try {
      if (job.kind === "deadline") {
        report.deadlines += 1;
        outcome = await runDeadline(job, deps);
      } else {
        report.drafts += 1;
        outcome = await runDraft(job, deps);
      }
    } catch (e) {
      report.errors += 1;
      outcome = "retry";
      error = (e as Error).message.slice(0, 200);
    }
    const draftSeconds = outcome === "poll" ? PLAN_PASS.draftPollSeconds : PLAN_PASS.draftCheckSeconds;
    const retrySeconds = job.kind === "draft" && !error ? draftSeconds : job.kind === "deadline" && !error ? 60 : 120;
    const n = await deps.completeJob(job, outcome === "poll" ? "retry" : outcome, error, retrySeconds).catch(() => 0);
    if (n === 0) deps.log("email_plan.job_not_ours", `job ${job.job_key} was no longer this pass's`, job.tenant_id);
  }
}

function weeklyRetryAt(deps: PassDeps, tz: string, monday: Date | null): Date | null {
  const now = deps.now().getTime();
  const fired = deps.nextFire(tz, new Date(now - 7 * 24 * 3_600_000));
  const late = fired && fired.getTime() <= now ? now - fired.getTime() : 0;
  if (late > PLAN_PASS.weeklyRetryWindowMs) return monday;
  const wait = Math.min(PLAN_PASS.weeklyRetryMaxMs, Math.max(PLAN_PASS.weeklyRetryMinMs, late));
  const retry = new Date(now + wait);
  return monday && monday.getTime() < retry.getTime() ? monday : retry;
}

async function runWeekly(deps: PassDeps, report: PassReport): Promise<void> {
  for (const tenantId of await deps.schedulesMissing(PLAN_PASS.missingLimit)) {
    try {
      const tz = (await deps.zoneOf(tenantId)) ?? "UTC";
      const next = deps.nextFire(tz, deps.now());
      if (!next) continue;
      await deps.rpc(tenantId, "set_email_plan_schedule", { p_next: next.toISOString(), p_tz: tz });
      report.scheduled += 1;
    } catch {
      report.errors += 1;
    }
  }
  for (const row of await deps.claimZoneChecks(PLAN_PASS.zoneCheckLimit).catch(() => [] as ScheduleRow[])) {
    try {
      const tz = await deps.zoneOf(row.tenant_id);
      if (!tz || tz === row.timezone) continue;
      const next = deps.nextFire(tz, deps.now());
      if (!next) continue;
      await deps.rpc(row.tenant_id, "set_email_plan_schedule", { p_next: next.toISOString(), p_tz: tz });
      report.rezoned += 1;
    } catch {
      report.errors += 1;
    }
  }
  for (const row of await deps.claimSchedules(PLAN_PASS.scheduleLimit)) {
    let request: string | null = null;
    let failed = false;
    try {
      const tz = (await deps.zoneOf(row.tenant_id)) ?? row.timezone;
      const eligible = await deps.weeklyEligible(row.tenant_id).catch(() => "retry" as const);
      if (eligible === "retry") {
        failed = true;
        deps.log("email_plan.weekly_lists_unread", "weekly plan waits: eligibility could not be read", row.tenant_id, "warn");
      } else if (eligible) {
        const week = wallDate(deps.now(), tz);
        request = `email-plan-week:${row.tenant_id}:${week}`;
        const started = await deps.startRun(row.tenant_id, { email_plan: { mode: "weekly_plan", timezone: tz, week_of: week } }, request);
        if (started.ok) report.weekly += 1;
        else {
          failed = true;
          deps.log("email_plan.weekly_not_started", `weekly plan not started: ${started.reason ?? "?"}`, row.tenant_id, "warn");
        }
      }
      const monday = deps.nextFire(tz, new Date(deps.now().getTime() + 60_000));
      const next = failed ? weeklyRetryAt(deps, tz, monday) : monday;
      await deps.rpc(row.tenant_id, "finish_email_plan_schedule", {
        p_token: row.lease_token,
        p_next: next ? next.toISOString() : null,
        p_request: request,
        p_tz: tz,
      });
    } catch {
      report.errors += 1;
    }
  }
}

export async function runEmailPlanPass(deps: PassDeps): Promise<PassReport> {
  const report: PassReport = { repaired: 0, resent: 0, jobs: 0, drafts: 0, deadlines: 0, weekly: 0, scheduled: 0, rezoned: 0, stuck_alerted: 0, errors: 0 };
  const deadline = deps.now().getTime() + PLAN_PASS.budgetMs;
  report.repaired = await deps.repair(PLAN_PASS.repairLimit).catch(() => {
    report.errors += 1;
    return 0;
  });
  const cutoff = deps.now().getTime() - 60_000;
  for (const row of await deps.outboxPending(PLAN_PASS.outboxLimit).catch(() => [] as OutboxRow[])) {
    if (Date.parse(row.created_at) > cutoff) continue;
    if (await emit(deps, row.tenant_id, { id: row.event_id, name: row.event_name, data: row.event_data })) report.resent += 1;
  }
  await runJobs(deps, report, deadline);
  if (deps.now().getTime() < deadline) await runWeekly(deps, report);
  report.stuck_alerted = await deps.alertStuckHolds(PLAN_PASS.stuckHoldLimit).catch(() => {
    report.errors += 1;
    return 0;
  });
  return report;
}

export { WEEKLY_PLAN_CRON };
