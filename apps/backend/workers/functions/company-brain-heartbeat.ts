
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

export const HEARTBEAT_MIN_RUNS = 3;
export const HEARTBEAT_MIN_DISTINCT_DAYS = 3;
export const HEARTBEAT_LOOKBACK_DAYS = 21;
const MAX_RUNS_SCANNED_PER_TENANT = 500;
const MAX_TENANTS_PER_SWEEP = 200;
export const HEARTBEAT_PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_DEFAULT_CRON = "0 14 * * *";

export const HEARTBEAT_DECISION_CLASS = "heartbeat.automation-proposal";

type TenantRow = { id: string };

type ManualRunRow = {
  agent_slug: string;
  enqueued_at: string;
  id: string;
  trigger: string;
};

export type HeartbeatCandidate = {
  agent_slug: string;
  run_count: number;
  distinct_days: number;
  source_run_ids: string[];
};

export function pickStrongestCandidate(
  manualRuns: ManualRunRow[],
  alreadyScheduledSlugs: ReadonlySet<string>,
): HeartbeatCandidate | null {
  const bySlug = new Map<string, { days: Set<string>; runIds: string[] }>();
  for (const r of manualRuns) {
    if (r.trigger !== "manual") continue;
    if (alreadyScheduledSlugs.has(r.agent_slug)) continue;
    if (typeof r.enqueued_at !== "string" || !r.enqueued_at) continue;
    const day = r.enqueued_at.slice(0, 10);
    let g = bySlug.get(r.agent_slug);
    if (!g) {
      g = { days: new Set<string>(), runIds: [] };
      bySlug.set(r.agent_slug, g);
    }
    g.days.add(day);
    if (g.runIds.length < 5) g.runIds.push(r.id);
  }

  const candidates: HeartbeatCandidate[] = [];
  for (const [agent_slug, g] of bySlug) {
    const run_count = manualRuns.filter(
      (r) => r.trigger === "manual" && r.agent_slug === agent_slug,
    ).length;
    const distinct_days = g.days.size;
    if (run_count >= HEARTBEAT_MIN_RUNS && distinct_days >= HEARTBEAT_MIN_DISTINCT_DAYS) {
      candidates.push({
        agent_slug,
        run_count,
        distinct_days,
        source_run_ids: g.runIds,
      });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      b.distinct_days - a.distinct_days ||
      b.run_count - a.run_count ||
      a.agent_slug.localeCompare(b.agent_slug),
  );
  return candidates[0];
}

export function renderProposalPreview(
  c: HeartbeatCandidate,
  cron_expression: string,
): string {
  return [
    `You've run **${c.agent_slug}** manually ${c.run_count} times across ${c.distinct_days} different days recently.`,
    ``,
    `Zavi can put this on autopilot: schedule **${c.agent_slug}** to run automatically on a daily cadence (\`${cron_expression}\`), so you don't have to kick it off by hand.`,
    ``,
    `Approve to create the schedule. Nothing runs until you do, and you can pause or re-time it any time.`,
  ].join("\n");
}

export function buildProposalBody(
  c: HeartbeatCandidate,
  cron_expression: string,
): Record<string, unknown> {
  return {
    agent_slug: c.agent_slug,
    cron_expression,
    objective: `Automated ${c.agent_slug} run (proposed by company-brain heartbeat from ${c.run_count} manual runs over ${c.distinct_days} days).`,
    preview_markdown: renderProposalPreview(c, cron_expression),
    pattern: {
      run_count: c.run_count,
      distinct_days: c.distinct_days,
      source_run_ids: c.source_run_ids,
    },
    source: "company-brain-heartbeat",
  };
}

async function loadManualRunsForTenant(tenant_id: string): Promise<ManualRunRow[]> {
  const sinceIso = new Date(
    Date.now() - HEARTBEAT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, agent_slug, trigger, enqueued_at")
    .eq("tenant_id", tenant_id)
    .eq("trigger", "manual")
    .gte("enqueued_at", sinceIso)
    .order("enqueued_at", { ascending: false })
    .limit(MAX_RUNS_SCANNED_PER_TENANT);
  if (error) {
    console.warn(
      `[company-brain-heartbeat] agent_runs read failed for ${tenant_id}: ${error.message}`,
    );
    return [];
  }
  return (data ?? []) as ManualRunRow[];
}

async function loadScheduledSlugs(tenant_id: string): Promise<Set<string>> {
  const { data, error } = await serviceClient()
    .from("tenant_agent_schedules")
    .select("agent_slug")
    .eq("tenant_id", tenant_id);
  if (error) {
    console.warn(
      `[company-brain-heartbeat] tenant_agent_schedules read failed for ${tenant_id}: ${error.message}`,
    );
    return new Set<string>();
  }
  return new Set(
    ((data ?? []) as { agent_slug: string }[]).map((r) => r.agent_slug),
  );
}

async function hasRecentProposal(tenant_id: string): Promise<boolean> {
  const windowStart = new Date(
    Date.now() - HEARTBEAT_PROPOSAL_WINDOW_MS,
  ).toISOString();
  const { count, error } = await serviceClient()
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("decision_class", HEARTBEAT_DECISION_CLASS)
    .eq("status", "proposed")
    .gte("emitted_at", windowStart);
  if (error) {
    console.warn(
      `[company-brain-heartbeat] recent-proposal count failed for ${tenant_id}: ${error.message} — failing closed (skip)`,
    );
    return true;
  }
  return (count ?? 0) > 0;
}

export type HeartbeatTenantOutcome =
  | { status: "skipped_disabled" }
  | { status: "skipped_no_pattern" }
  | { status: "skipped_rate_limited" }
  | { status: "proposed"; agent_slug: string; decision_id: string }
  | { status: "error"; reason: string };

export async function proposeAutomationForTenant(
  tenant_id: string,
): Promise<HeartbeatTenantOutcome> {
  const enabled = await getBoolSetting("memory_heartbeat_enabled", tenant_id);
  if (!enabled) {
    return { status: "skipped_disabled" };
  }

  if (await hasRecentProposal(tenant_id)) {
    return { status: "skipped_rate_limited" };
  }

  const [manualRuns, scheduledSlugs] = await Promise.all([
    loadManualRunsForTenant(tenant_id),
    loadScheduledSlugs(tenant_id),
  ]);

  const candidate = pickStrongestCandidate(manualRuns, scheduledSlugs);
  if (!candidate) {
    return { status: "skipped_no_pattern" };
  }

  const body = buildProposalBody(candidate, HEARTBEAT_DEFAULT_CRON);

  const { data: decisionRpc, error: emitErr } = await serviceClient().rpc(
    "emit_decision",
    {
      p_tenant_id: tenant_id,
      p_agent_run_id: null,
      p_decision_class: HEARTBEAT_DECISION_CLASS,
      p_body: body,
    },
  );
  if (emitErr) {
    return { status: "error", reason: `emit_decision failed: ${emitErr.message}` };
  }
  const decision_id = decisionRpc as unknown as string;
  return { status: "proposed", agent_slug: candidate.agent_slug, decision_id };
}

export type HeartbeatLogger = {
  warn: (s: string) => void;
  info: (s: string) => void;
  error: (s: string) => void;
};

export async function runCompanyBrainHeartbeat(logger: HeartbeatLogger): Promise<{
  scanned: number;
  proposed: number;
  skipped_disabled: number;
  skipped_no_pattern: number;
  skipped_rate_limited: number;
  errored: number;
  halted?: boolean;
}> {
  const svc = serviceClient();

  const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
  if (killErr) {
    logger.error(
      `company-brain-heartbeat: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`,
    );
    return {
      scanned: 0,
      proposed: 0,
      skipped_disabled: 0,
      skipped_no_pattern: 0,
      skipped_rate_limited: 0,
      errored: 0,
      halted: true,
    };
  }
  if (halted === true) {
    return {
      scanned: 0,
      proposed: 0,
      skipped_disabled: 0,
      skipped_no_pattern: 0,
      skipped_rate_limited: 0,
      errored: 0,
      halted: true,
    };
  }

  const { data, error } = await svc
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(MAX_TENANTS_PER_SWEEP);
  if (error) {
    logger.error(`company-brain-heartbeat: tenant scan failed: ${error.message}`);
    return {
      scanned: 0,
      proposed: 0,
      skipped_disabled: 0,
      skipped_no_pattern: 0,
      skipped_rate_limited: 0,
      errored: 0,
    };
  }
  const tenants = (data ?? []) as TenantRow[];

  let proposed = 0;
  let skipped_disabled = 0;
  let skipped_no_pattern = 0;
  let skipped_rate_limited = 0;
  let errored = 0;

  for (const t of tenants) {
    try {
      const outcome = await proposeAutomationForTenant(t.id);
      switch (outcome.status) {
        case "proposed":
          proposed += 1;
          break;
        case "skipped_disabled":
          skipped_disabled += 1;
          break;
        case "skipped_no_pattern":
          skipped_no_pattern += 1;
          break;
        case "skipped_rate_limited":
          skipped_rate_limited += 1;
          break;
        case "error":
          errored += 1;
          logger.warn(`[company-brain-heartbeat] tenant ${t.id} errored: ${outcome.reason}`);
          break;
      }
    } catch (e) {
      errored += 1;
      logger.warn(
        `[company-brain-heartbeat] tenant ${t.id} threw: ${(e as Error).message}`,
      );
    }
  }

  await logEvent({
    level: "info",
    source: "memory.heartbeat",
    code: "sweep",
    meta: { total: tenants.length, count: proposed },
  });

  logger.info(
    `company-brain-heartbeat: scanned ${tenants.length}, proposed ${proposed}, ` +
      `disabled ${skipped_disabled}, no_pattern ${skipped_no_pattern}, ` +
      `rate_limited ${skipped_rate_limited}, errored ${errored}`,
  );
  return {
    scanned: tenants.length,
    proposed,
    skipped_disabled,
    skipped_no_pattern,
    skipped_rate_limited,
    errored,
  };
}

export const companyBrainHeartbeatFn = inngest.createFunction(
  { id: "company-brain-heartbeat", concurrency: 1 },
  { cron: "40 8 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("company-brain-heartbeat")) {
      return { cron_stopped: true as const };
    }
    return runCompanyBrainHeartbeat(logger);
  },
);
