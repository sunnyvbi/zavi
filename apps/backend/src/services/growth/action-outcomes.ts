
import { serviceClient } from "@/services/supabase";
import { readNativeFunnel } from "@/services/tools/growth/native_funnel";
import { fbGet, metaAdsCreds, metaActionValue } from "@/services/tools/meta-ads/_client";
import { gadsSearch } from "@/services/tools/google-ads/_client";

const MAX_RECONCILE_PER_RUN = 200;

const DEFAULT_WINDOW_DAYS = 30;

export const MAX_RECONCILE_ATTEMPTS = 6;

export type TargetKind = "native_event" | "meta_object" | "google_object" | "linkedin_object";

export type MetaMetricSnapshot = {
  spend: number | null;
  roas: number | null;
  conversions: number | null;
  purchase_value: number | null;
  impressions: number | null;
};

export type PendingOutcomeRow = {
  id: number;
  tenant_id: string;
  decision_id: string;
  subject_type: string;
  subject_id: string;
  target_metric: string;
  baseline_metrics: Record<string, unknown> | null;
  measurement_window_days: number;
  reconcile_after: string;
  attempt_count: number;
  action_class: string;
  decision_outcome: "approved" | "rejected";
  outcome_tier: "business" | "delivery";
};

export type OutcomeReadResult =
  | { kind: "measured"; snapshot: Record<string, unknown>; window_start: string; window_end: string }
  | { kind: "no_data" }
  | { kind: "error"; message: string };

export type ReconcileBatchResult = {
  scanned: number;
  measured: number;
  no_data: number;
  errors: number;
  noop: number;
};

export async function recordActionOutcome(args: {
  decisionId: string;
  actionClass: string;
  decisionOutcome: "approved" | "rejected";
  subjectType: "campaign" | "adset" | "ad" | "pr" | "email" | "other";
  subjectId: string;
  subjectName?: string | null;
  targetMetric?: string;
  measurementWindowDays?: number;
  baselineMetrics?: Record<string, unknown> | null;
  outcomeTier?: "business" | "delivery";
}): Promise<number | null> {
  const sc = serviceClient();
  const { data, error } = await sc.rpc("record_action_outcome", {
    p_decision_id: args.decisionId,
    p_action_class: args.actionClass,
    p_decision_outcome: args.decisionOutcome,
    p_subject_type: args.subjectType,
    p_subject_id: args.subjectId,
    p_subject_name: args.subjectName ?? null,
    p_target_metric: args.targetMetric ?? "spend",
    p_measurement_window_days: args.measurementWindowDays ?? 14,
    p_baseline_metrics: args.baselineMetrics ?? {},
    p_outcome_tier: args.outcomeTier ?? "business",
  });
  if (error) return null;
  return typeof data === "number" ? data : null;
}

export async function enrichBaseline(args: {
  id: number;
  baselineMetrics?: Record<string, unknown> | null;
  status?: "enriched" | "no_data" | "error";
  subjectName?: string | null;
  error?: string | null;
}): Promise<boolean> {
  const sc = serviceClient();
  const { data, error } = await sc.rpc("enrich_action_outcome_baseline", {
    p_id: args.id,
    p_baseline_metrics: args.baselineMetrics ?? {},
    p_status: args.status ?? "enriched",
    p_subject_name: args.subjectName ?? null,
    p_error: args.error ?? null,
  });
  if (error) return false;
  return data === true;
}

export async function readMetaSnapshot(
  tenantId: string,
  subjectId: string,
  since: string,
  until: string,
): Promise<MetaMetricSnapshot | null> {
  await metaAdsCreds(tenantId);
  const params: Record<string, string | number | undefined> = {
    time_range: JSON.stringify({ since, until }),
    time_increment: "all_days",
    fields: "spend,impressions,actions,action_values",
  };
  const j = (await fbGet(tenantId, `${subjectId}/insights`, params)) as {
    data?: Array<{
      spend?: string;
      impressions?: string;
      actions?: Array<{ action_type?: string; value?: string }>;
      action_values?: Array<{ action_type?: string; value?: string }>;
    }>;
  };
  const row = (j.data ?? [])[0];
  if (!row) return null;
  const spend = Number(row.spend ?? 0);
  const purchases = metaActionValue(row.actions, "purchase");
  const checkouts = metaActionValue(row.actions, "initiate_checkout");
  const regs =
    metaActionValue(row.actions, "complete_registration") ||
    metaActionValue(row.actions, "offsite_conversion.fb_pixel_complete_registration");
  const conv = purchases + checkouts + regs;
  const purchaseValue = metaActionValue(row.action_values, "purchase");
  return {
    spend: round2(spend),
    roas: spend > 0 ? round2(purchaseValue / spend) : null,
    conversions: round2(conv),
    purchase_value: round2(purchaseValue),
    impressions: Number(row.impressions ?? 0),
  };
}

export async function readGoogleSnapshot(
  tenantId: string,
  subjectId: string,
  since: string,
  until: string,
): Promise<MetaMetricSnapshot | null> {
  if (!/^[0-9]+$/.test(subjectId)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  const query = `
    SELECT
      campaign.id,
      metrics.cost_micros,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE campaign.id = ${subjectId}
      AND segments.date BETWEEN '${since}' AND '${until}'
  `;
  const raw = (await gadsSearch(tenantId, query)) as Array<{
    metrics?: {
      costMicros?: string;
      impressions?: string;
      conversions?: string;
      conversionsValue?: string;
    };
  }>;
  if (!raw.length) return null;
  let spend = 0;
  let impressions = 0;
  let conversions = 0;
  let conversionsValue = 0;
  for (const r of raw) {
    spend += Number(r.metrics?.costMicros ?? 0) / 1_000_000;
    impressions += Number(r.metrics?.impressions ?? 0);
    conversions += Number(r.metrics?.conversions ?? 0);
    conversionsValue += Number(r.metrics?.conversionsValue ?? 0);
  }
  return {
    spend: round2(spend),
    roas: spend > 0 ? round2(conversionsValue / spend) : null,
    conversions: round2(conversions),
    purchase_value: round2(conversionsValue),
    impressions,
  };
}

export function targetKindForClass(actionClass: string | null | undefined): TargetKind {
  const cls = actionClass ?? "";
  if (cls.startsWith("google_ads.")) return "google_object";
  if (cls.startsWith("linkedin_ads.")) return "linkedin_object";
  return "meta_object";
}

export async function readMetricValue(
  row: PendingOutcomeRow,
  targetKind: TargetKind,
  nowIso = new Date().toISOString(),
): Promise<OutcomeReadResult> {
  try {
    if (targetKind === "meta_object" || targetKind === "google_object" || targetKind === "linkedin_object") {
      const end = new Date(row.reconcile_after);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - row.measurement_window_days);
      const nowDate = new Date(nowIso);
      const clampedEnd = end > nowDate ? nowDate : end;
      const since = ymd(start);
      const until = ymd(clampedEnd);
      const snap =
        targetKind === "google_object"
          ? await readGoogleSnapshot(row.tenant_id, row.subject_id, since, until)
          : targetKind === "linkedin_object"
            ? await (await import("@/services/connectors/linkedin-ads/outcome-snapshot")).readLinkedInSnapshot(row.tenant_id, row.subject_id, since, until)
            : await readMetaSnapshot(row.tenant_id, row.subject_id, since, until);
      if (!snap) return { kind: "no_data" };
      return { kind: "measured", snapshot: snap, window_start: start.toISOString(), window_end: clampedEnd.toISOString() };
    }
    const funnel = await readNativeFunnel(row.tenant_id, [row.target_metric], DEFAULT_WINDOW_DAYS);
    if (!funnel.has_data) return { kind: "no_data" };
    const step = funnel.steps.find((s) => s.event === row.target_metric);
    if (!step) return { kind: "no_data" };
    return {
      kind: "measured",
      snapshot: { spend: null, roas: null, conversions: step.count, purchase_value: null, impressions: null },
      window_start: new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400_000).toISOString(),
      window_end: nowIso,
    };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}

type DecisionDispatchRow = {
  status: string;
  dispatch_error: string | null;
  dispatched_at: string | null;
  agent_run_id: string | null;
};

async function readDecisionDispatch(decisionId: string): Promise<DecisionDispatchRow> {
  const sc = serviceClient();
  const { data, error } = await sc
    .from("decisions")
    .select("status, dispatch_error, dispatched_at, agent_run_id")
    .eq("id", decisionId)
    .maybeSingle();
  if (error) throw new Error(`decision read failed: ${error.message}`);
  if (!data) throw new Error(`decision ${decisionId} not found`);
  return data as DecisionDispatchRow;
}

export async function readEmailDeliveryOutcome(
  row: PendingOutcomeRow,
  nowIso = new Date().toISOString(),
): Promise<OutcomeReadResult> {
  try {
    const dec = await readDecisionDispatch(row.decision_id);
    if (dec.status === "acted") {
      return {
        kind: "measured",
        snapshot: { delivered: true, dispatch_status: "acted" },
        window_start: dec.dispatched_at ?? nowIso,
        window_end: nowIso,
      };
    }
    if (dec.status === "rejected") {
      return {
        kind: "measured",
        snapshot: {
          delivered: false,
          dispatch_status: "dispatch_error",
          dispatch_error: (dec.dispatch_error ?? "unknown").slice(0, 300),
        },
        window_start: dec.dispatched_at ?? nowIso,
        window_end: nowIso,
      };
    }
    return { kind: "no_data" };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}

export async function readPrDeliveryOutcome(
  row: PendingOutcomeRow,
  nowIso = new Date().toISOString(),
): Promise<OutcomeReadResult> {
  try {
    const dec = await readDecisionDispatch(row.decision_id);
    if (dec.status === "rejected") {
      return {
        kind: "measured",
        snapshot: {
          delivered: false,
          pr_state: "failed_to_open",
          dispatch_error: (dec.dispatch_error ?? "unknown").slice(0, 300),
        },
        window_start: dec.dispatched_at ?? nowIso,
        window_end: nowIso,
      };
    }
    if (dec.status !== "acted") return { kind: "no_data" };
    if (!dec.agent_run_id) return { kind: "no_data" };

    const sc = serviceClient();
    const { data: runData, error: runErr } = await sc
      .from("agent_runs")
      .select("parsed")
      .eq("id", dec.agent_run_id)
      .maybeSingle();
    if (runErr) throw new Error(`agent_run read failed: ${runErr.message}`);
    const parsed = ((runData as { parsed?: Record<string, unknown> } | null)?.parsed ??
      {}) as Record<string, unknown>;
    const pr_url = typeof parsed.pr_url === "string" ? parsed.pr_url : null;
    const pr_number = typeof parsed.pr_number === "number" ? parsed.pr_number : null;
    const pr_repo = typeof parsed.pr_repo === "string" ? parsed.pr_repo : null;
    const pr_state = typeof parsed.pr_state === "string" ? parsed.pr_state : null;

    if (pr_state === "failed_to_open") {
      return {
        kind: "measured",
        snapshot: { delivered: false, pr_state: "failed_to_open" },
        window_start: dec.dispatched_at ?? nowIso,
        window_end: nowIso,
      };
    }
    if (!pr_url) return { kind: "no_data" };

    const delivered = { delivered: true, pr_url, pr_number } as Record<string, unknown>;
    const measured = (state: string): OutcomeReadResult => ({
      kind: "measured",
      snapshot: { ...delivered, pr_state: state },
      window_start: dec.dispatched_at ?? nowIso,
      window_end: nowIso,
    });

    if (parsed.merged === true || pr_state === "merged") return measured("merged");
    if (pr_state === "closed_unmerged") return measured("closed");

    const repoFull = pr_repo ?? row.subject_id.split("#")[0] ?? "";
    const [owner, repoName] = repoFull.split("/");
    if (!owner || !repoName || pr_number == null) return measured("unknown");
    try {
      const { callMcpTool } = await import("@/services/mcp/execute");
      const r = await callMcpTool(
        { tenant_id: row.tenant_id, run_id: dec.agent_run_id },
        "github",
        "get_pr",
        { owner, repo: repoName, pull_number: pr_number },
      );
      if (r.is_error) return measured("unknown");
      const pr = JSON.parse(r.content) as { state?: string; merged?: boolean };
      if (pr.merged === true) return measured("merged");
      if (pr.state === "closed") return measured("closed");
      if (pr.state === "open") return measured("open");
      return measured("unknown");
    } catch {
      return measured("unknown");
    }
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}

export function computeDelta(
  baseline: Record<string, unknown> | null,
  outcome: MetaMetricSnapshot,
  ctx: { decisionOutcome: "approved" | "rejected"; actionClass: string; windowDays: number },
): Record<string, unknown> {
  const b = (baseline ?? {}) as Partial<MetaMetricSnapshot>;
  const delta: Record<string, unknown> = {};
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bSpend = num(b.spend);
  const oSpend = num(outcome.spend);
  if (bSpend !== null && oSpend !== null) delta.spend = round2(oSpend - bSpend);
  const bRoas = num(b.roas);
  const oRoas = num(outcome.roas);
  if (bRoas !== null && oRoas !== null) delta.roas = round2(oRoas - bRoas);
  const bConv = num(b.conversions);
  const oConv = num(outcome.conversions);
  if (bConv !== null && oConv !== null) delta.conversions = round2(oConv - bConv);

  if (ctx.decisionOutcome === "approved" && ctx.actionClass.startsWith("meta_ads.set_status") && bSpend !== null) {
    const avoided = Math.max(0, round2(bSpend - (oSpend ?? 0)));
    delta.spend_avoided_estimate = avoided;
    delta.spend_avoided_inputs = {
      baseline_window_spend: round2(bSpend),
      observed_window_spend: oSpend ?? 0,
      window_days: ctx.windowDays,
      method: "baseline_window_spend_minus_observed",
    };
  }
  return delta;
}

export async function reconcileOutcomeBatch(
  rows: PendingOutcomeRow[],
  readMetric: (row: PendingOutcomeRow) => Promise<OutcomeReadResult>,
  writeOutcome: (row: PendingOutcomeRow, read: OutcomeReadResult) => Promise<{ applied: boolean }>,
): Promise<ReconcileBatchResult> {
  let measured = 0;
  let no_data = 0;
  let errors = 0;
  let noop = 0;

  for (const row of rows) {
    const read = await readMetric(row);
    const { applied } = await writeOutcome(row, read);
    if (!applied) {
      noop++;
      continue;
    }
    if (read.kind === "measured") measured++;
    else if (read.kind === "no_data") no_data++;
    else errors++;
  }

  return { scanned: rows.length, measured, no_data, errors, noop };
}

export async function reconcilePendingOutcomes(
  nowIso = new Date().toISOString(),
): Promise<ReconcileBatchResult> {
  const sc = serviceClient();
  const { data, error } = await sc
    .from("action_outcomes")
    .select(
      "id, tenant_id, decision_id, subject_type, subject_id, target_metric, baseline_metrics, measurement_window_days, reconcile_after, attempt_count, action_class, decision_outcome, outcome_tier",
    )
    .eq("reconcile_status", "pending")
    .lte("reconcile_after", nowIso)
    .lt("attempt_count", MAX_RECONCILE_ATTEMPTS)
    .order("reconcile_after", { ascending: true })
    .limit(MAX_RECONCILE_PER_RUN);
  if (error) {
    throw new Error(`reconcilePendingOutcomes scan failed: ${error.message}`);
  }
  const rows = (data ?? []) as PendingOutcomeRow[];

  return reconcileOutcomeBatch(
    rows,
    (row) =>
      row.subject_type === "pr"
        ? readPrDeliveryOutcome(row, nowIso)
        : row.subject_type === "email"
          ? readEmailDeliveryOutcome(row, nowIso)
          : readMetricValue(row, targetKindForClass(row.action_class), nowIso),
    async (row, read) => {
      if (read.kind === "measured") {
        const delta =
          row.outcome_tier === "delivery"
            ? {}
            : computeDelta(row.baseline_metrics, read.snapshot as MetaMetricSnapshot, {
                decisionOutcome: row.decision_outcome,
                actionClass: row.action_class,
                windowDays: row.measurement_window_days,
              });
        const { data: applied, error: wErr } = await sc.rpc("reconcile_action_outcome", {
          p_id: row.id,
          p_status: "measured",
          p_outcome_metrics: read.snapshot,
          p_delta_metrics: delta,
          p_window_start: read.window_start,
          p_window_end: read.window_end,
          p_error: null,
        });
        if (wErr) {
          await sc.rpc("bump_action_outcome_attempt", { p_id: row.id, p_error: wErr.message });
          return { applied: false };
        }
        return { applied: applied === true };
      }

      const status = read.kind === "no_data" ? "no_data" : "error";
      const errMsg = read.kind === "error" ? read.message : null;
      const { data: applied, error: wErr } = await sc.rpc("reconcile_action_outcome", {
        p_id: row.id,
        p_status: status,
        p_outcome_metrics: {},
        p_delta_metrics: {},
        p_window_start: null,
        p_window_end: null,
        p_error: errMsg,
      });
      if (wErr) {
        await sc.rpc("bump_action_outcome_attempt", { p_id: row.id, p_error: wErr.message });
        return { applied: false };
      }
      return { applied: applied === true };
    },
  );
}

export type OutcomeSignal = {
  action_class: string;
  decision_outcome: string;
  n: number;
  avg_spend_delta: number | null;
  avg_roas_delta: number | null;
  last_measured_at: string | null;
};

export type ActionOutcomeSignalResult = {
  tenant_id: string;
  window: string;
  signals: OutcomeSignal[];
};

export async function getActionOutcomeSignal(
  tenantId: string,
  windowInterval = "90 days",
): Promise<ActionOutcomeSignalResult> {
  const sc = serviceClient();
  const { data, error } = await sc.rpc("get_action_outcome_signal", {
    p_tenant_id: tenantId,
    p_window: windowInterval,
  });
  if (error) {
    throw new Error(`get_action_outcome_signal failed: ${error.message}`);
  }
  return data as ActionOutcomeSignalResult;
}

export type GrowthBetOutcome = {
  bet_decision_id: string;
  bet_class: string;
  bet_claim: string | null;
  bet_emitted_at: string;
  outcome_decision_id: string;
  action_class: string;
  decision_outcome: string;
  target_metric: string;
  spend_delta: number | null;
  roas_delta: number | null;
  measured_at: string | null;
};

export type GrowthBetOutcomeResult = {
  tenant_id: string;
  window: string;
  bets: GrowthBetOutcome[];
};

export async function getGrowthBetOutcomes(
  tenantId: string,
  windowInterval = "90 days",
  limit = 20,
): Promise<GrowthBetOutcomeResult> {
  const sc = serviceClient();
  const { data, error } = await sc.rpc("get_growth_bet_outcomes", {
    p_tenant_id: tenantId,
    p_window: windowInterval,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`get_growth_bet_outcomes failed: ${error.message}`);
  }
  return data as GrowthBetOutcomeResult;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
