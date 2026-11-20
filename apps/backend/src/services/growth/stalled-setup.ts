
import type { SupabaseClient } from "@supabase/supabase-js";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { APP_SETTINGS } from "@/services/settings/registry";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { chunks, must } from "./first-plan-watch";

const MIN = 60 * 1000;
export const STALLED_WINDOW_MS = 24 * 60 * MIN;
const TAKEOVERS_PER_TICK = 1;
const CANDIDATE_LIMIT = 500;

export type StalledCandidate = {
  tenant_id: string;
  slug: string | null;
  kind: string | null;
  created_at: string;
  setup_docs_at: string | null;
  setup_connectors_at: string | null;
  setup_done_at: string | null;
};

export type StalledSetupReads = {
  candidates: (from: string, before: string) => Promise<StalledCandidate[]>;
  leaving: (ids: string[]) => Promise<Set<string>>;
  setupOn: (tenant_id: string) => Promise<boolean>;
  buildIntent: (tenant_id: string) => Promise<string>;
  hadPlanOrDraft: (tenant_id: string) => Promise<boolean>;
};

export type StalledSetupDeps = {
  reads: StalledSetupReads;
  afterSetting: () => Promise<unknown>;
  research: (tenant_id: string) => Promise<unknown>;
  skipSetup: (tenant_id: string) => Promise<void>;
  log: (e: { level: "info" | "warn"; code: string; tenant_id: string; message: string }) => Promise<void>;
  now?: () => number;
};

const TICK_FAILURE_LOG_EVERY_MS = 60 * MIN;
let tickFailureLoggedAt = 0;
export function stalledTickFailureLogDue(now: number = Date.now()): boolean {
  if (now - tickFailureLoggedAt < TICK_FAILURE_LOG_EVERY_MS) return false;
  tickFailureLoggedAt = now;
  return true;
}

type StalledSetupSummary = { checked: number; taken: number; skipped: number; errors: number };

export function stalledAfterMs(stored: unknown): number {
  const def = APP_SETTINGS.first_plan_stalled_setup_minutes;
  const v = stored === undefined ? def.defaultValue : stored;
  if (typeof v !== "number" || !Number.isInteger(v) || v < def.min || v > def.max) {
    throw new Error(`first_plan_stalled_setup_minutes must be a whole number from ${def.min} to ${def.max}`);
  }
  return v * MIN;
}

type StalledVerdict =
  | { due: true; since: string }
  | { due: false; reason: "excluded" | "finished" | "too_soon" | "too_old" };

export function stalledSetupDue(c: StalledCandidate, now: number, afterMs: number): StalledVerdict {
  if (c.kind !== "real" || (c.slug !== null && DOGFOOD_SLUGS.has(c.slug))) return { due: false, reason: "excluded" };
  if (c.setup_connectors_at || c.setup_done_at) return { due: false, reason: "finished" };
  if (now - Date.parse(c.created_at) >= STALLED_WINDOW_MS) return { due: false, reason: "too_old" };
  const since = c.setup_docs_at ?? c.created_at;
  if (now - Date.parse(since) < afterMs) return { due: false, reason: "too_soon" };
  return { due: true, since };
}

export async function runStalledSetupTakeover(
  deps: StalledSetupDeps,
): Promise<StalledSetupSummary | { cron_stopped: true } | { off: true }> {
  if (isWorkerCronStopped("first-plan-watch")) return { cron_stopped: true };
  const afterMs = stalledAfterMs(await deps.afterSetting());
  if (afterMs === 0) return { off: true };
  const now = (deps.now ?? Date.now)();
  const iso = (ms: number) => new Date(ms).toISOString();
  const out: StalledSetupSummary = { checked: 0, taken: 0, skipped: 0, errors: 0 };
  const due: Array<{ c: StalledCandidate; since: string }> = [];
  for (const c of await deps.reads.candidates(iso(now - STALLED_WINDOW_MS), iso(now - afterMs))) {
    const v = stalledSetupDue(c, now, afterMs);
    if (v.due) due.push({ c, since: v.since });
  }
  if (due.length === 0) return out;
  const leaving = await deps.reads.leaving(due.map((d) => d.c.tenant_id));
  for (const { c, since } of due) {
    if (out.taken >= TAKEOVERS_PER_TICK) break;
    const t = c.tenant_id;
    out.checked += 1;
    try {
      if (
        leaving.has(t) ||
        !(await deps.reads.setupOn(t)) ||
        (await deps.reads.buildIntent(t)) === "fresh" ||
        (await deps.reads.hadPlanOrDraft(t))
      ) {
        out.skipped += 1;
        continue;
      }
      await deps.research(t);
      await deps.skipSetup(t);
      out.taken += 1;
      const minutes = Math.round((now - Date.parse(since)) / MIN);
      await deps.log({
        level: "info",
        code: "first_plan_stalled_setup",
        tenant_id: t,
        message: `setup unfinished ${minutes} min after ${since === c.created_at ? "signup" : "Past work"}: skipped the rest, first plan watch enrolled`,
      });
    } catch (e) {
      out.errors += 1;
      await deps.log({ level: "warn", code: "first_plan_stalled_setup_failed", tenant_id: t, message: (e as Error).message });
    }
  }
  return out;
}

export function stalledSetupReads(
  svc: SupabaseClient,
  rest: Pick<StalledSetupReads, "leaving" | "setupOn" | "buildIntent">,
): StalledSetupReads {
  return {
    ...rest,
    async candidates(from, before) {
      const tenants = (must(
        await svc
          .from("tenants")
          .select("id, slug, kind, created_at")
          .gte("created_at", from)
          .lt("created_at", before)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
          .limit(CANDIDATE_LIMIT),
        "tenants",
      ) ?? []) as Array<{ id: string; slug: string | null; kind: string | null; created_at: string }>;
      const progress = new Map<string, Pick<StalledCandidate, "setup_docs_at" | "setup_connectors_at" | "setup_done_at">>();
      for (const part of chunks(tenants.map((t) => t.id))) {
        const rows = (must(
          await svc
            .from("tenant_first_run_progress")
            .select("tenant_id, setup_docs_at, setup_connectors_at, setup_done_at")
            .in("tenant_id", part),
          "progress",
        ) ?? []) as Array<{ tenant_id: string } & Pick<StalledCandidate, "setup_docs_at" | "setup_connectors_at" | "setup_done_at">>;
        for (const r of rows) progress.set(r.tenant_id, r);
      }
      return tenants.map((t) => {
        const p = progress.get(t.id);
        return {
          tenant_id: t.id,
          slug: t.slug,
          kind: t.kind,
          created_at: t.created_at,
          setup_docs_at: p?.setup_docs_at ?? null,
          setup_connectors_at: p?.setup_connectors_at ?? null,
          setup_done_at: p?.setup_done_at ?? null,
        };
      });
    },
    async hadPlanOrDraft(tenant_id) {
      const plans = must(await svc.from("growth_plan").select("id").eq("tenant_id", tenant_id).limit(1), "plan") as unknown[] | null;
      if ((plans ?? []).length > 0) return true;
      const drafts = must(
        await svc
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("agent_slug", "cgo")
          .like("cron_dedupe_key", `cgo:draft:${tenant_id}:%`)
          .limit(1),
        "draft",
      ) as unknown[] | null;
      return (drafts ?? []).length > 0;
    },
  };
}
