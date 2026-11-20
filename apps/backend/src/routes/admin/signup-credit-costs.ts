import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { costToCredits } from "@/services/agents/credits";
import {
  isDoneForYouIdentity,
  isSignupPreviewIdentity,
  PREVIEW_DONE_KEY_PREFIX,
} from "@/services/billing/tiers";
import {
  firstGoalReviewKey,
  firstGoalReviewRetryKey,
} from "@/services/growth/goal-review-identity";
import { isRefundableSetupDraft } from "@/services/growth/setup-draft";
import { SIGNUP_ATTRIBUTION_KEY } from "@/services/tenants/signup-attribution";
import {
  funnelCohort,
  readPages,
  signupSource,
  type FunnelAttribution,
  type FunnelTenant,
} from "./funnel";

const DAY = 86_400_000;
const TERMINAL = new Set([
  "success",
  "failed",
  "error",
  "parse_failed",
  "cancelled",
  "dispatch_error",
]);
export type CostTenant = FunnelTenant & {
  product_url?: unknown;
  deleted_at?: string | null;
};
export type CostRun = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  enqueued_by: string | null;
  cron_dedupe_key: string | null;
  status: string;
  enqueued_at: string;
  finished_at: string | null;
  cost_usd: number | string | null;
  build_id: string | null;
};
export type CostEvidence = {
  refunds: { tenant_id: string; run_id: string }[];
  builds: { tenant_id: string; id: string }[];
};
type Category =
  | "signup_preview"
  | "done_for_you"
  | "setup_draft_subsidy"
  | "free_first_build"
  | "first_goal_review";
export type CostEntry = {
  run_id: string;
  tenant_id: string;
  date: string;
  source: string;
  source_kind: string;
  category: Category;
  status: string;
  credits: number;
  usd: number;
  over_1000: boolean;
};

export function isTeamWebsite(value: unknown): boolean {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { marketing?: unknown }).marketing
        : null;
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    return host === "upcar.ai" || host === "zaviagent.com";
  } catch {
    return false;
  }
}

export function signupCostCohort(tenants: CostTenant[]): CostTenant[] {
  const allowed = new Set(funnelCohort(tenants, false).map((t) => t.id));
  return tenants.filter(
    (t) => allowed.has(t.id) && !t.deleted_at && !isTeamWebsite(t.product_url),
  );
}

export function aggregateSignupCosts(
  tenants: CostTenant[],
  runs: CostRun[],
  attribution: FunnelAttribution[],
  evidence: CostEvidence,
  since: string,
  until: string,
) {
  const sinceMs = Date.parse(since),
    untilMs = Date.parse(until);
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const sources = new Map(
    attribution.map((a) => [a.tenant_id, signupSource(a.value)]),
  );
  const refunds = new Set(
    evidence.refunds.map((r) => `${r.tenant_id}:${r.run_id}`),
  );
  const builds = new Set(
    evidence.builds.map((b) => `${b.tenant_id}:${b.id.toLowerCase()}`),
  );
  const entries: CostEntry[] = [];
  let unfinishedRuns = 0,
    missingCostRuns = 0,
    otherRuns = 0;
  for (const run of runs) {
    const tenant = tenantById.get(run.tenant_id);
    if (!tenant) continue;
    const start = Date.parse(run.enqueued_at),
      signup = Date.parse(tenant.created_at);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(signup) ||
      start < signup ||
      start >= signup + 14 * DAY
    )
      continue;
    const facts = {
      payload: null,
      trigger: run.trigger,
      enqueuedByUser: run.enqueued_by !== null,
      cronDedupeKey: run.cron_dedupe_key,
    };
    let category: Category | null = null;
    if (isSignupPreviewIdentity(run.tenant_id, run.agent_slug, facts))
      category = "signup_preview";
    else if (
      run.enqueued_by === null &&
      run.trigger === "channel_recipe" &&
      run.cron_dedupe_key === `${PREVIEW_DONE_KEY_PREFIX}${run.tenant_id}:${run.agent_slug}`
    )
      category = "signup_preview";
    else if (isDoneForYouIdentity(run.tenant_id, facts))
      category = "done_for_you";
    else if (
      run.agent_slug === "cgo" &&
      run.trigger === "a2a" &&
      run.enqueued_by === null &&
      [
        firstGoalReviewKey(run.tenant_id),
        firstGoalReviewRetryKey(run.tenant_id),
      ].includes(run.cron_dedupe_key ?? "")
    )
      category = "first_goal_review";
    else if (
      refunds.has(`${run.tenant_id}:${run.id}`) &&
      isRefundableSetupDraft(run.tenant_id, run)
    )
      category = "setup_draft_subsidy";
    else if (
      run.enqueued_by === null &&
      run.trigger === "a2a" &&
      run.build_id &&
      builds.has(`${run.tenant_id}:${run.build_id.toLowerCase()}`)
    )
      category = "free_first_build";
    if (!category) {
      otherRuns++;
      continue;
    }
    const finished = Date.parse(run.finished_at ?? "");
    if (!TERMINAL.has(run.status) || !Number.isFinite(finished)) {
      unfinishedRuns++;
      continue;
    }
    if (
      finished < sinceMs ||
      finished >= untilMs ||
      finished >= signup + 14 * DAY
    )
      continue;
    const usd = run.cost_usd === null ? NaN : Number(run.cost_usd);
    if (!Number.isFinite(usd) || usd < 0) {
      missingCostRuns++;
      continue;
    }
    const source = sources.get(run.tenant_id) ?? signupSource(null);
    const credits = costToCredits(usd);
    entries.push({
      run_id: run.id,
      tenant_id: run.tenant_id,
      date: new Date(finished).toISOString().slice(0, 10),
      source: source.source,
      source_kind: source.kind,
      category,
      status: run.status,
      credits,
      usd,
      over_1000: category === "done_for_you" && credits > 1000,
    });
  }
  entries.sort(
    (a, b) => b.date.localeCompare(a.date) || a.run_id.localeCompare(b.run_id),
  );
  const groups = new Map<
    string,
    {
      date: string;
      source: string;
      source_kind: string;
      runs: number;
      credits: number;
      usd: number;
      done_for_you_credits: number;
      over_1000_runs: number;
    }
  >();
  for (const entry of entries) {
    const key = JSON.stringify([entry.date, entry.source_kind, entry.source]);
    const row = groups.get(key) ?? {
      date: entry.date,
      source: entry.source,
      source_kind: entry.source_kind,
      runs: 0,
      credits: 0,
      usd: 0,
      done_for_you_credits: 0,
      over_1000_runs: 0,
    };
    row.runs++;
    row.credits += entry.credits;
    row.usd += entry.usd;
    if (entry.category === "done_for_you")
      row.done_for_you_credits += entry.credits;
    if (entry.over_1000) row.over_1000_runs++;
    groups.set(key, row);
  }
  return {
    rows: [...groups.values()],
    entries,
    credits: entries.reduce((n, r) => n + r.credits, 0),
    usd: entries.reduce((n, r) => n + r.usd, 0),
    unfinishedRuns,
    missingCostRuns,
    otherRuns,
    freeOrCompedCredits: null,
  };
}

export async function staffSignupCreditCosts(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const until = new Date().toISOString();
  const todayUtc = Date.parse(until.slice(0, 10) + "T00:00:00Z");
  const since = new Date(todayUtc - 13 * DAY).toISOString();
  const cohortSince = new Date(Date.parse(since) - 14 * DAY).toISOString();
  const sb = staffCrossTenantClient(
    "admin/signup-credit-costs: read-only launch subsidy report for bounded signup cohort",
  );
  try {
    const select = "id, created_at, kind, slug, product_url, deleted_at";
    const [created, claims] = await Promise.all([
      readPages<CostTenant>((from, to) =>
        sb
          .from("tenants")
          .select(select)
          .gte("created_at", cohortSince)
          .lt("created_at", until)
          .order("id")
          .range(from, to),
      ),
      readPages<{ tenant_id: string; claimed_at: string }>((from, to) =>
        sb
          .from("launch_video_public_jobs")
          .select("tenant_id, claimed_at")
          .gte("claimed_at", cohortSince)
          .lt("claimed_at", until)
          .order("id")
          .range(from, to),
      ),
    ]);
    const byId = new Map(created.map((t) => [t.id, t]));
    const claimDates = new Map<string, string>();
    for (const c of claims)
      if (
        !claimDates.has(c.tenant_id) ||
        c.claimed_at < claimDates.get(c.tenant_id)!
      )
        claimDates.set(c.tenant_id, c.claimed_at);
    const older = [...claimDates.keys()].filter((id) => !byId.has(id));
    for (let i = 0; i < older.length; i += 100)
      for (const t of await readPages<CostTenant>((from, to) =>
        sb
          .from("tenants")
          .select(select)
          .in("id", older.slice(i, i + 100))
          .order("id")
          .range(from, to),
      ))
        byId.set(t.id, t);
    const all = [...byId.values()].map((t) => ({
      ...t,
      created_at: claimDates.get(t.id) ?? t.created_at,
    }));
    const tenants = signupCostCohort(all);
    const runs: CostRun[] = [],
      attribution: FunnelAttribution[] = [];
    const evidence: CostEvidence = { refunds: [], builds: [] };
    for (let i = 0; i < tenants.length; i += 100) {
      const ids = tenants.slice(i, i + 100).map((t) => t.id);
      const [r, a, f, b] = await Promise.all([
        readPages<CostRun>((from, to) =>
          sb
            .from("agent_runs")
            .select(
              "id, tenant_id, agent_slug, trigger, enqueued_by, cron_dedupe_key, status, enqueued_at, finished_at, cost_usd, build_id:payload->>build_conductor_run_id",
            )
            .in("tenant_id", ids)
            .gte("enqueued_at", cohortSince)
            .lt("enqueued_at", until)
            .order("id")
            .range(from, to),
        ),
        readPages<FunnelAttribution>((from, to) =>
          sb
            .from("tenant_app_setting")
            .select("tenant_id, value")
            .eq("key", SIGNUP_ATTRIBUTION_KEY)
            .in("tenant_id", ids)
            .order("tenant_id")
            .range(from, to),
        ),
        readPages<CostEvidence["refunds"][number]>((from, to) =>
          sb
            .from("setup_draft_refunds")
            .select("tenant_id, run_id")
            .in("tenant_id", ids)
            .order("run_id")
            .order("attempt")
            .range(from, to),
        ),
        readPages<CostEvidence["builds"][number]>((from, to) =>
          sb
            .from("conductor_runs")
            .select("tenant_id, id")
            .in("tenant_id", ids)
            .eq("kind", "build_app")
            .eq("credits_waived", true)
            .order("id")
            .range(from, to),
        ),
      ]);
      runs.push(...r);
      attribution.push(...a);
      evidence.refunds.push(...f);
      evidence.builds.push(...b);
    }
    res.json({
      ...aggregateSignupCosts(
        tenants,
        runs,
        attribution,
        evidence,
        since,
        until,
      ),
      since,
      until,
      excluded: all.length - tenants.length,
      workspaces: tenants.length,
    });
  } catch {
    res.status(500).json({
      error: {
        code: "signup_credit_costs_read_failed",
        message: "Could not load signup costs. No partial totals are shown.",
      },
    });
  }
}
