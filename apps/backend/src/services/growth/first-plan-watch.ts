
import type { SupabaseClient } from "@supabase/supabase-js";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isProviderOutageError } from "@/services/agents/infra-retry";
import { observedExecution, providerRecoveredSince, providerVerdict, type OutageCandidate } from "@/services/agents/outage-retry";
import { MODEL_REFUSAL_CODE } from "@/services/agents/sdk-refusal";
import type { UsageLimitStatus } from "@/services/agents/usage-limit-status";
import type { alert as alertFn, emailOpsAlert as emailOpsAlertFn } from "@/services/logging/alert";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { getAppSetting } from "@/services/settings";
import { APP_SETTINGS } from "@/services/settings/registry";
import type { SetupDraftStart } from "@/services/setup/draft-start";
import { SETUP_DRAFT_IN_FLIGHT, setupDraftAttempt, setupDraftPrefix } from "./setup-draft";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const FIRST_PLAN_ALERT_AFTER_MS = 30 * MIN;
export const FIRST_PLAN_RETRY_SETTLE_MS = 30_000;
export const DUE_LIMIT = 100;
const STARTS_PER_TICK = 5;
export const BACKFILL_PAGE = 200;
export const BACKFILL_MAX_PAGES = 500;
export const BACKFILL_STARTS = 25;
export const BACKFILL_BEFORE_MS = DAY;

export type WatchRow = {
  tenant_id: string;
  setup_connectors_at: string;
  alert_bucket: string | null;
  alert_emailed_bucket: string | null;
};
export type WatchPatch = {
  next_check_at?: string;
  resolved_at?: string;
  resolved_reason?: "plan" | "excluded";
  alert_bucket?: string;
  alert_emailed_bucket?: string;
};
export type LatestDraft = {
  id: string;
  status: string;
  cron_dedupe_key: string | null;
  error: string | null;
  finished_at: string | null;
};

export type FirstPlanReads = {
  due: (now: string, limit: number) => Promise<WatchRow[]>;
  tenants: (ids: string[]) => Promise<{ slug: Map<string, string | null>; excluded: Set<string> }>;
  leaving: (ids: string[]) => Promise<Set<string>>;
  enrollBackfill: (from: string, before: string, now: number) => Promise<WatchRow[]>;
  hadPlan: (tenant_id: string) => Promise<boolean>;
  latestDraft: (tenant_id: string) => Promise<LatestDraft | null>;
  draftInFlight: (tenant_id: string) => Promise<boolean>;
  receiptPhase: (tenant_id: string, run_id: string) => Promise<string | null>;
  observed: (tenant_id: string, run_id: string) => Promise<boolean>;
  verdict: (since: string) => Promise<UsageLimitStatus>;
  setupOn: (tenant_id: string) => Promise<boolean>;
  update: (tenant_id: string, patch: WatchPatch) => Promise<void>;
};

export type FirstPlanWatchDeps = {
  reads: FirstPlanReads;
  start: (tenant_id: string, attempt: 1 | 2) => Promise<SetupDraftStart>;
  alert: typeof alertFn;
  emailAlert: typeof emailOpsAlertFn;
  log: (e: { level: "info" | "warn"; code: string; tenant_id: string | null; run_id?: string | null; message?: string }) => Promise<void>;
  now?: () => number;
};

export type FirstPlanWatchSummary = {
  checked: number;
  started: number;
  retried: number;
  alerted: number;
  resolved: number;
  errors: number;
  skipped_leaving: number;
};
export type BackfillSkip = { tenant_id: string; reason: string };
export type FirstPlanBackfillSummary = FirstPlanWatchSummary & {
  backfill: { from: string; before: string; enrolled: number; skipped: BackfillSkip[] };
};
export type FirstPlanWatchOptions = { backfillFrom?: string };

const FAILED = new Set(["failed", "dispatch_error"]);

export function retrySkip(tenant_id: string, run: LatestDraft, now: number): string | null {
  if (setupDraftAttempt(tenant_id, run.cron_dedupe_key) !== 1) return "not_first_attempt";
  if (!FAILED.has(run.status)) return "not_failed";
  if ((run.error ?? "").startsWith(`${MODEL_REFUSAL_CODE}:`)) return "refusal";
  const finished = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
  if (!Number.isFinite(finished)) return "not_finished";
  if (now - finished < FIRST_PLAN_RETRY_SETTLE_MS) return "settling";
  return null;
}

export function failureClass(run: LatestDraft | null): string {
  if (!run?.error) return run ? "none" : "no draft";
  if (isProviderOutageError(run.error)) return "provider outage";
  if (run.status === "dispatch_error" || /^(boot_reap|watchdog_reap):/.test(run.error)) return "infra";
  return "other";
}

export function alertBucket(setup_connectors_at: string, now: number): string {
  const age = now - Date.parse(setup_connectors_at);
  return age < 7 * DAY ? new Date(now).toISOString().slice(0, 10) : `w${Math.floor(age / (7 * DAY))}`;
}

export function nextCheckDelay(setup_connectors_at: string, now: number, busy: boolean): number {
  const age = now - Date.parse(setup_connectors_at);
  if (busy || age < HOUR) return 2 * MIN;
  if (age < DAY) return 15 * MIN;
  if (age < 7 * DAY) return HOUR;
  return 6 * HOUR;
}

function minutesSince(at: string, now: number): number {
  return Math.round((now - Date.parse(at)) / 60_000);
}

async function startBlocked(deps: FirstPlanWatchDeps, tenant_id: string): Promise<"deletion_requested" | "excluded" | null> {
  if ((await deps.reads.leaving([tenant_id])).has(tenant_id)) return "deletion_requested";
  const { slug, excluded } = await deps.reads.tenants([tenant_id]);
  if (excluded.has(tenant_id) || !slug.has(tenant_id)) return "excluded";
  return null;
}

async function shouldRetry(deps: FirstPlanWatchDeps, t: WatchRow, run: LatestDraft, now: number): Promise<boolean> {
  if (retrySkip(t.tenant_id, run, now) !== null) return false;
  if ((await deps.reads.receiptPhase(t.tenant_id, run.id)) !== null) return false;
  if (await deps.reads.observed(t.tenant_id, run.id)) return false;
  if (isProviderOutageError(run.error)) {
    return providerRecoveredSince(run.finished_at, await deps.reads.verdict(run.finished_at as string));
  }
  return true;
}

export function backfillFromMs(from: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return Number.NaN;
  const ms = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== from) return Number.NaN;
  return ms;
}

export function runFirstPlanWatch(deps: FirstPlanWatchDeps): Promise<FirstPlanWatchSummary | { cron_stopped: true }>;
export function runFirstPlanWatch(
  deps: FirstPlanWatchDeps,
  opts: { backfillFrom: string },
): Promise<FirstPlanBackfillSummary>;
export async function runFirstPlanWatch(
  deps: FirstPlanWatchDeps,
  opts: FirstPlanWatchOptions = {},
): Promise<FirstPlanWatchSummary | FirstPlanBackfillSummary | { cron_stopped: true }> {
  const backfill = opts.backfillFrom !== undefined;
  if (!backfill && isWorkerCronStopped("first-plan-watch")) return { cron_stopped: true };
  const now = (deps.now ?? Date.now)();
  const iso = (ms: number) => new Date(ms).toISOString();
  const out: FirstPlanWatchSummary = { checked: 0, started: 0, retried: 0, alerted: 0, resolved: 0, errors: 0, skipped_leaving: 0 };
  const startCap = backfill ? BACKFILL_STARTS : STARTS_PER_TICK;
  const skipped: BackfillSkip[] = [];
  const skip = (tenant_id: string, reason: string) => {
    if (backfill) skipped.push({ tenant_id, reason });
  };
  let rows: WatchRow[];
  let window: FirstPlanBackfillSummary["backfill"] | null = null;
  if (backfill) {
    const fromMs = backfillFromMs(opts.backfillFrom as string);
    if (!Number.isFinite(fromMs)) throw new Error("first-plan-watch backfill: invalid from");
    const from = iso(fromMs);
    const before = iso(now - BACKFILL_BEFORE_MS);
    if (fromMs >= now - BACKFILL_BEFORE_MS) throw new Error("first-plan-watch backfill: from must be more than 24 hours ago");
    rows = await deps.reads.enrollBackfill(from, before, now);
    window = { from, before, enrolled: rows.length, skipped };
  } else {
    rows = await deps.reads.due(iso(now), DUE_LIMIT);
  }
  if (rows.length === 0) return window ? finishBackfill(deps, out, window, now) : out;
  const ids = rows.map((r) => r.tenant_id);
  const { slug, excluded } = await deps.reads.tenants(ids);
  let leaving: Set<string>;
  try {
    leaving = await deps.reads.leaving(ids);
  } catch (e) {
    await deps
      .emailAlert({
        source: "first-plan-watch",
        code: "first_plan_watch_deletions_unreadable",
        msg: "First plan watch cannot read account deletions or its skip list; it started nothing.",
        email: { dedupeKey: `first_plan_watch_deletions_unreadable:${iso(now).slice(0, 10)}`, subjectDetail: "First plan watch stopped" },
      })
      .catch(() => false);
    throw e;
  }
  for (const t of rows) {
    out.checked += 1;
    const patch: WatchPatch = {};
    let busy = false;
    try {
      if (excluded.has(t.tenant_id) || !slug.has(t.tenant_id)) {
        await deps.reads.update(t.tenant_id, { resolved_at: iso(now), resolved_reason: "excluded" });
        out.resolved += 1;
        skip(t.tenant_id, "excluded");
        continue;
      }
      if (leaving.has(t.tenant_id)) {
        await deps.reads.update(t.tenant_id, { next_check_at: iso(now + DAY) });
        out.skipped_leaving += 1;
        skip(t.tenant_id, "deletion_requested");
        continue;
      }
      if (await deps.reads.hadPlan(t.tenant_id)) {
        await deps.reads.update(t.tenant_id, { resolved_at: iso(now), resolved_reason: "plan" });
        out.resolved += 1;
        continue;
      }
      if (!(await deps.reads.setupOn(t.tenant_id))) {
        await deps.reads.update(t.tenant_id, { next_check_at: iso(now + DAY) });
        skip(t.tenant_id, "setup_off");
        continue;
      }
      const run = await deps.reads.latestDraft(t.tenant_id);
      let action: string | null = null;
      let reason: string | null = null;
      const blockedNow = async (): Promise<boolean> => {
        busy = true;
        const blocked = await startBlocked(deps, t.tenant_id);
        if (blocked === "deletion_requested") {
          await deps.reads.update(t.tenant_id, { next_check_at: iso(now + DAY) });
          out.skipped_leaving += 1;
          skip(t.tenant_id, blocked);
          return true;
        }
        if (blocked === "excluded") {
          await deps.reads.update(t.tenant_id, { resolved_at: iso(now), resolved_reason: "excluded" });
          out.resolved += 1;
          skip(t.tenant_id, blocked);
          return true;
        }
        return false;
      };
      if (!run) {
        if (await deps.reads.draftInFlight(t.tenant_id)) {
          busy = true;
          reason = "draft_in_flight";
        } else if (out.started + out.retried >= startCap) {
          busy = true;
          reason = "start_cap";
        } else if (await blockedNow()) {
          continue;
        } else {
          const res = await deps.start(t.tenant_id, 1);
          busy = true;
          if ("status" in res && res.status === "queued") {
            out.started += 1;
            action = "started";
            await deps.log({ level: "info", code: backfill ? "first_plan_backfill_started" : "first_plan_backstop_started", tenant_id: t.tenant_id, run_id: res.run_id });
          } else reason = "status" in res ? "already_started" : "waiting_on_research_or_file";
        }
      } else if ((SETUP_DRAFT_IN_FLIGHT as readonly string[]).includes(run.status)) {
        busy = true;
        reason = "draft_in_flight";
      } else if (await shouldRetry(deps, t, run, now)) {
        busy = true;
        if (out.started + out.retried >= startCap) reason = "start_cap";
        else if (await blockedNow()) continue;
        else {
          const res = await deps.start(t.tenant_id, 2);
          if ("status" in res && res.status === "queued") {
            out.retried += 1;
            action = "retried";
            await deps.log({ level: "info", code: backfill ? "first_plan_backfill_retried" : "first_plan_retry_started", tenant_id: t.tenant_id, run_id: res.run_id, message: `after ${run.id}` });
          } else reason = "status" in res ? "already_started" : "waiting_on_research_or_file";
        }
      } else {
        reason = `not_retried:${run.status}`;
      }
      if (reason) skip(t.tenant_id, reason);
      if (!backfill && now - Date.parse(t.setup_connectors_at) >= FIRST_PLAN_ALERT_AFTER_MS) {
        const bucket = alertBucket(t.setup_connectors_at, now);
        const page = missingPlanPage(t, slug.get(t.tenant_id) ?? null, run, action, now, bucket);
        if (t.alert_bucket !== bucket) {
          await deps.alert({ source: page.source, code: page.code, tenant_id: t.tenant_id, msg: page.msg });
          patch.alert_bucket = bucket;
          out.alerted += 1;
        }
        if (t.alert_emailed_bucket !== bucket && (await deps.emailAlert(page))) patch.alert_emailed_bucket = bucket;
      }
    } catch (e) {
      out.errors += 1;
      skip(t.tenant_id, "error");
      await deps.log({ level: "warn", code: "first_plan_watch_failed", tenant_id: t.tenant_id, message: (e as Error).message });
    }
    try {
      await deps.reads.update(t.tenant_id, { ...patch, next_check_at: iso(now + nextCheckDelay(t.setup_connectors_at, now, busy)) });
    } catch (e) {
      out.errors += 1;
      await deps.log({ level: "warn", code: "first_plan_watch_failed", tenant_id: t.tenant_id, message: (e as Error).message });
    }
  }
  return window ? finishBackfill(deps, out, window, now) : out;
}

async function finishBackfill(
  deps: FirstPlanWatchDeps,
  out: FirstPlanWatchSummary,
  backfill: FirstPlanBackfillSummary["backfill"],
  now: number,
): Promise<FirstPlanBackfillSummary> {
  const msg =
    `First plan backfill from ${backfill.from.slice(0, 10)}: enrolled ${backfill.enrolled}, checked ${out.checked}, ` +
    `started ${out.started}, retried ${out.retried}, skipped ${backfill.skipped.length}, errors ${out.errors}.`;
  try {
    await deps.alert({ source: "first-plan-watch", code: "first_plan_backfill", msg });
    await deps.emailAlert({
      source: "first-plan-watch",
      code: "first_plan_backfill",
      msg,
      email: {
        dedupeKey: `first_plan_backfill:${backfill.from.slice(0, 10)}:${new Date(now).toISOString().slice(0, 10)}`,
        subjectDetail: `First plan backfill: ${out.started} started, ${out.retried} retried`,
        detail: [
          msg,
          `Window: setup finished ${backfill.from} to ${backfill.before}.`,
          "",
          "Skipped (tenant id: reason):",
          ...(backfill.skipped.length ? backfill.skipped.map((s) => `${s.tenant_id}: ${s.reason}`) : ["none"]),
        ].join("\n"),
      },
    });
  } catch (e) {
    await deps.log({ level: "warn", code: "first_plan_backfill_alert_failed", tenant_id: null, message: (e as Error).message });
  }
  return { ...out, backfill };
}

function missingPlanPage(t: WatchRow, slug: string | null, run: LatestDraft | null, action: string | null, now: number, bucket: string) {
  const minutes = minutesSince(t.setup_connectors_at, now);
  return {
    source: "first-plan-watch",
    code: "first_plan_missing",
    tenant_id: t.tenant_id,
    msg: `No first growth plan ${minutes} min after setup for tenant ${t.tenant_id}.`,
    email: {
      dedupeKey: `first_plan_missing:${t.tenant_id}:${bucket}`,
      subjectDetail: `No first plan: ${slug ?? t.tenant_id}`,
      required: true,
      detail: [
        `Tenant: ${slug ?? "?"} (${t.tenant_id})`,
        `Setup connectors step finished ${minutes} minutes ago; no growth plan.`,
        run
          ? `Latest setup draft: run ${run.id}, attempt ${setupDraftAttempt(t.tenant_id, run.cron_dedupe_key) ?? "?"}, status ${run.status}, failure ${failureClass(run)}.`
          : "No setup draft run exists.",
        action ? `This check just ${action === "started" ? "started attempt 1" : "started attempt 2"}.` : "",
        "",
        "Zavi starts a missing first plan after 3 minutes and retries attempt 1 once when it failed before any tool ran.",
        "One email per workspace per day for the first week after setup, then one a week until it has a plan.",
      ].filter(Boolean).join("\n"),
    },
  };
}

type Svc = SupabaseClient;
export function chunks(ids: string[], size = 40): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const LIVE_DELETION_STATUSES = ["pending", "soft_deleted", "held"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function skipList(stored: unknown): string[] {
  const v = stored === undefined ? APP_SETTINGS.first_plan_watch_skip_tenants.defaultValue : stored;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && UUID_RE.test(x))) {
    throw new Error("first_plan_watch_skip_tenants must be a list of workspace uuids");
  }
  return (v as string[]).map((x) => x.toLowerCase());
}

export function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`first-plan-watch ${what} read failed: ${res.error.message}`);
  return res.data;
}

export function firstPlanReads(svc: Svc, setupOn: (tenant_id: string) => Promise<boolean>): FirstPlanReads {
  return {
    async due(now, limit) {
      return (must(
        await svc
          .from("first_plan_watch")
          .select("tenant_id, setup_connectors_at, alert_bucket, alert_emailed_bucket")
          .is("resolved_at", null)
          .lte("next_check_at", now)
          .order("next_check_at", { ascending: true })
          .order("tenant_id", { ascending: true })
          .limit(limit),
        "watch",
      ) ?? []) as WatchRow[];
    },
    async tenants(ids) {
      const rows: Array<{ id: string; slug: string | null; kind: string | null; deleted_at: string | null }> = [];
      for (const part of chunks(ids)) {
        rows.push(...((must(await svc.from("tenants").select("id, slug, kind, deleted_at").in("id", part), "tenants") ?? []) as typeof rows));
      }
      const slug = new Map<string, string | null>();
      const excluded = new Set<string>();
      for (const r of rows) {
        slug.set(r.id, r.slug);
        if (r.kind !== "real" || r.deleted_at || (r.slug && DOGFOOD_SLUGS.has(r.slug))) excluded.add(r.id);
      }
      return { slug, excluded };
    },
    async leaving(ids) {
      const out = new Set<string>();
      const wanted = new Set(ids);
      for (const part of chunks(ids)) {
        const rows = (must(
          await svc
            .from("account_deletions")
            .select("deleted_tenant_ids")
            .in("status", [...LIVE_DELETION_STATUSES])
            .overlaps("deleted_tenant_ids", part),
          "deletions",
        ) ?? []) as Array<{ deleted_tenant_ids: string[] | null }>;
        for (const r of rows) for (const id of r.deleted_tenant_ids ?? []) if (wanted.has(id)) out.add(id);
      }
      for (const id of skipList(await getAppSetting("first_plan_watch_skip_tenants", null, { strict: true }))) {
        if (wanted.has(id)) out.add(id);
      }
      return out;
    },
    async enrollBackfill(from, before, now) {
      const inserted: WatchRow[] = [];
      for (let page = 0; ; page += 1) {
        const rows = (must(
          await svc
            .from("tenant_first_run_progress")
            .select("tenant_id, setup_connectors_at")
            .gte("setup_connectors_at", from)
            .lt("setup_connectors_at", before)
            .order("setup_connectors_at", { ascending: true })
            .order("tenant_id", { ascending: true })
            .range(page * BACKFILL_PAGE, page * BACKFILL_PAGE + BACKFILL_PAGE - 1),
          "progress",
        ) ?? []) as Array<{ tenant_id: string; setup_connectors_at: string }>;
        if (!rows.length) break;
        if (page >= BACKFILL_MAX_PAGES) throw new Error(`first-plan-watch backfill window holds more than ${BACKFILL_MAX_PAGES * BACKFILL_PAGE} setups; use a later from`);
        const planned = new Set<string>();
        for (const part of chunks(rows.map((r) => r.tenant_id))) {
          const got = (must(await svc.from("growth_plan").select("tenant_id").in("tenant_id", part), "plans") ?? []) as Array<{ tenant_id: string }>;
          for (const g of got) planned.add(g.tenant_id);
        }
        const strands = rows.filter((r) => !planned.has(r.tenant_id));
        if (strands.length) {
          const { data, error } = await svc
            .from("first_plan_watch")
            .upsert(
              strands.map((r) => {
                const bucket = alertBucket(r.setup_connectors_at, now);
                return {
                  tenant_id: r.tenant_id,
                  setup_connectors_at: r.setup_connectors_at,
                  next_check_at: new Date(now + HOUR).toISOString(),
                  alert_bucket: bucket,
                  alert_emailed_bucket: bucket,
                };
              }),
              { onConflict: "tenant_id", ignoreDuplicates: true },
            )
            .select("tenant_id, setup_connectors_at, alert_bucket, alert_emailed_bucket");
          if (error) throw new Error(`first-plan-watch enrol failed: ${error.message}`);
          inserted.push(...((data ?? []) as WatchRow[]));
        }
        if (rows.length < BACKFILL_PAGE) break;
      }
      return inserted.sort(
        (a, b) => a.setup_connectors_at.localeCompare(b.setup_connectors_at) || a.tenant_id.localeCompare(b.tenant_id),
      );
    },
    async hadPlan(tenant_id) {
      const rows = must(await svc.from("growth_plan").select("id").eq("tenant_id", tenant_id).limit(1), "plan") as unknown[] | null;
      return (rows ?? []).length > 0;
    },
    async latestDraft(tenant_id) {
      const rows = must(
        await svc
          .from("agent_runs")
          .select("id, status, cron_dedupe_key, error, finished_at")
          .eq("tenant_id", tenant_id)
          .eq("agent_slug", "cgo")
          .eq("trigger", "a2a")
          .is("enqueued_by", null)
          .like("cron_dedupe_key", `${setupDraftPrefix(tenant_id)}%`)
          .order("enqueued_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1),
        "draft",
      ) as LatestDraft[] | null;
      return rows?.[0] ?? null;
    },
    async draftInFlight(tenant_id) {
      const rows = must(
        await svc
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("agent_slug", "cgo")
          .in("status", [...SETUP_DRAFT_IN_FLIGHT])
          .like("cron_dedupe_key", `cgo:draft:${tenant_id}:%`)
          .limit(1),
        "in-flight",
      ) as unknown[] | null;
      return (rows ?? []).length > 0;
    },
    async receiptPhase(tenant_id, run_id) {
      const rows = must(
        await svc.from("growth_strategy_delivery").select("phase").eq("tenant_id", tenant_id).eq("run_id", run_id).limit(1),
        "receipt",
      ) as Array<{ phase: string }> | null;
      return rows?.[0]?.phase ?? null;
    },
    observed: (tenant_id, run_id) => observedExecution(svc, { id: run_id, tenant_id } as OutageCandidate),
    verdict: (since) => providerVerdict(svc, since),
    setupOn,
    async update(tenant_id, patch) {
      const { error } = await svc
        .from("first_plan_watch")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenant_id);
      if (error) throw new Error(`first-plan-watch update failed: ${error.message}`);
    },
  };
}
