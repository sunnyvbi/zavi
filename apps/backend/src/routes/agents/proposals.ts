
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { isAdsManagerTriageFocusEnabled } from "./triage-focus-flag";
import {
  assembleBrief,
  TREND_WINDOWS,
  type CampaignMetric,
  type DecisionBrief,
  type MeasuredOutcome,
} from "./proposal-brief";
import { metaListCampaignsTool } from "@/services/tools/meta-ads/list_campaigns";
import type { ToolContext } from "@/services/tools/types";

type DecisionRow = {
  id: string;
  tenant_id?: string;
  agent_run_id: string | null;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
  status: string;
  emitted_at: string;
};

type RevisionRow = {
  id: string;
  decision_id: string;
  agent_run_id: string | null;
  thread_id: string | null;
  status: string;
  message: string;
  original_decision_class?: string | null;
  original_handler?: string | null;
  original_body?: Record<string, unknown> | null;
  assistant_text: string | null;
  replacement_decision_id: string | null;
  last_error: string | null;
  created_at: string;
};

type RunRow = { id: string; status: string; payload?: Record<string, unknown> | null };

function runRevisesDecisionId(run: RunRow | undefined): string | null {
  const rr = (run?.payload as { revision_request?: { revises_decision_id?: unknown } } | null | undefined)
    ?.revision_request?.revises_decision_id;
  return typeof rr === "string" ? rr : null;
}
type ReplacementRow = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown> | null;
  status: string;
  emitted_at: string;
};

type BucketKey =
  | "pause"
  | "budget_down"
  | "budget_up"
  | "resume"
  | "new"
  | "other";

const BUCKET_ORDER: { key: BucketKey; label: string }[] = [
  { key: "pause", label: "Pausing" },
  { key: "budget_down", label: "Cutting budget" },
  { key: "budget_up", label: "Raising" },
  { key: "resume", label: "Resuming" },
  { key: "new", label: "New ad sets" },
  { key: "other", label: "Other changes" },
];

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bucketFor(decisionClass: string, body: Record<string, unknown> | null): BucketKey {
  const b = body ?? {};
  if (decisionClass.startsWith("meta_ads.set_status")) {
    return String(b.status).toUpperCase() === "PAUSED" ? "pause" : "resume";
  }
  if (
    decisionClass.startsWith("meta_ads.update_ad_set_budget") ||
    decisionClass.startsWith("meta_ads.update_campaign_budget")
  ) {
    const next = num(b.daily_budget_usd);
    const cur = num(b.expected_current_daily_budget_usd);
    if (next !== null && cur !== null) return next >= cur ? "budget_up" : "budget_down";
    return "budget_up";
  }
  if (decisionClass.startsWith("meta_ads.create_ad_set")) return "new";
  return "other";
}

const TERMINAL_SUCCESS = new Set(["success"]);
const TERMINAL_FAILED = new Set(["failed", "parse_failed", "dispatch_error", "cancelled"]);
export const REVISION_STALE_MS = 10 * 60 * 1000;

function decisionTarget(decisionClass: string, body: Record<string, unknown> | null | undefined): string | null {
  const b = body ?? {};
  const value =
    typeof b.object_id === "string" && b.object_id.trim()
      ? b.object_id.trim()
      : typeof b.ad_set_id === "string" && b.ad_set_id.trim()
        ? b.ad_set_id.trim()
        : typeof b.campaign_id === "string" && b.campaign_id.trim()
          ? `${b.campaign_id.trim()}|${typeof b.name === "string" ? b.name.trim() : ""}`
          : null;
  return value ? `${decisionClass}:${value}` : null;
}

export function pickRevisionReplacement(
  revision: RevisionRow,
  replacements: ReplacementRow[],
  revisesDecisionId: string | null = null,
): ReplacementRow | null {
  if (replacements.length === 0) return null;
  if (revisesDecisionId !== null && revisesDecisionId !== revision.decision_id) return null;
  const originalTarget = decisionTarget(
    revision.original_decision_class ?? "",
    revision.original_body ?? null,
  );
  if (originalTarget) {
    const sameTarget = replacements.find((d) => decisionTarget(d.decision_class, d.body) === originalTarget);
    if (sameTarget) return sameTarget;
  }
  return replacements.length === 1 ? replacements[0] : null;
}

export function classifyRevisionResolution(
  revision: RevisionRow,
  run: RunRow | undefined,
  replacements: ReplacementRow[],
  nowMs = Date.now(),
):
  | { kind: "replacement"; replacement: ReplacementRow | { id: string } }
  | { kind: "stale_failed"; last_error: string }
  | { kind: "run_failed"; last_error: string }
  | { kind: "responded" }
  | { kind: "none" } {
  const replacement = revision.replacement_decision_id
    ? { id: revision.replacement_decision_id }
    : pickRevisionReplacement(revision, replacements, runRevisesDecisionId(run));
  if (replacement) return { kind: "replacement", replacement };

  if ((revision.status === "requested" || revision.status === "running") && revision.created_at) {
    const ageMs = nowMs - new Date(revision.created_at).getTime();
    if (ageMs > REVISION_STALE_MS) {
      return {
        kind: "stale_failed",
        last_error: revision.last_error ?? "Revision request timed out. You can approve the original or ask again.",
      };
    }
  }

  if (run && TERMINAL_FAILED.has(run.status)) {
    return { kind: "run_failed", last_error: revision.last_error ?? run.status };
  }
  if (run && TERMINAL_SUCCESS.has(run.status)) return { kind: "responded" };
  return { kind: "none" };
}

async function reconcileRevisions(
  tenantId: string,
  revisions: RevisionRow[],
  runById: Map<string, RunRow>,
  replacementsByRunId: Map<string, ReplacementRow[]>,
): Promise<Set<string>> {
  const sb = serviceClient();
  const hiddenDecisionIds = new Set<string>();
  const now = Date.now();
  for (const r of revisions) {
    const run = r.agent_run_id ? runById.get(r.agent_run_id) : undefined;
    const replacements = r.agent_run_id ? replacementsByRunId.get(r.agent_run_id) ?? [] : [];
    const resolution = classifyRevisionResolution(r, run, replacements, now);

    if (resolution.kind === "replacement") {
      hiddenDecisionIds.add(r.decision_id);
      await Promise.all([
        sb
          .from("decisions")
          .update({
            status: "superseded",
            superseded_at: new Date().toISOString(),
            superseded_by: resolution.replacement.id,
          })
          .eq("id", r.decision_id)
          .eq("tenant_id", tenantId)
          .eq("status", "proposed"),
        sb
          .from("decision_revision_requests")
          .update({
            status: "revised",
            replacement_decision_id: resolution.replacement.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.id)
          .eq("tenant_id", tenantId),
      ]);
      r.status = "revised";
      r.replacement_decision_id = resolution.replacement.id;
      continue;
    }

    if (resolution.kind === "none" && replacements.length > 1) {
      console.warn(
        "revision replacement ambiguous; leaving original proposed",
        r.id,
        r.agent_run_id,
        replacements.map((d) => d.id),
      );
    }

    if ((resolution.kind === "stale_failed" || resolution.kind === "run_failed") && r.status !== "failed") {
      r.status = "failed";
      r.last_error = resolution.last_error;
      await sb
        .from("decision_revision_requests")
        .update({ status: "failed", last_error: r.last_error, updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("tenant_id", tenantId);
    } else if (resolution.kind === "responded" && r.status !== "responded") {
      r.status = "responded";
      await sb
        .from("decision_revision_requests")
        .update({ status: "responded", updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("tenant_id", tenantId);
    }
  }
  return hiddenDecisionIds;
}

function revisionView(
  r: RevisionRow | undefined,
  runById: Map<string, RunRow>,
  replacementsByRunId: Map<string, ReplacementRow[]>,
) {
  if (!r) return null;
  const viewRun = r.agent_run_id ? runById.get(r.agent_run_id) : undefined;
  const replacement =
    r.replacement_decision_id
      ? ({ id: r.replacement_decision_id } as ReplacementRow)
      : r.agent_run_id
        ? pickRevisionReplacement(r, replacementsByRunId.get(r.agent_run_id) ?? [], runRevisesDecisionId(viewRun))
        : undefined;
  if (replacement) {
    return { ...r, status: "revised", replacement_decision_id: replacement.id };
  }
  const run = r.agent_run_id ? runById.get(r.agent_run_id) : undefined;
  if (run && TERMINAL_FAILED.has(run.status)) {
    return { ...r, status: "failed", last_error: r.last_error ?? run.status };
  }
  if (run && TERMINAL_SUCCESS.has(run.status)) {
    return { ...r, status: "responded" };
  }
  return r;
}

function publicRevisionStatus(
  rv: ReturnType<typeof revisionView>,
): { id: string; status: string; replacement_decision_id: string | null; created_at: string } | null {
  if (!rv) return null;
  return {
    id: rv.id,
    status: rv.status,
    replacement_decision_id: rv.replacement_decision_id ?? null,
    created_at: rv.created_at,
  };
}

export type BriefableDecision = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
};

function campaignIdOf(body: Record<string, unknown> | null): string | null {
  const v = body?.campaign_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function reasoningOf(body: Record<string, unknown> | null): string | null {
  const ev = body?.decision_evidence;
  const reason =
    ev && typeof ev === "object" && typeof (ev as { reason_text?: unknown }).reason_text === "string"
      ? ((ev as { reason_text?: string }).reason_text ?? null)
      : null;
  const rationale = typeof body?.rationale === "string" ? (body.rationale as string) : null;
  return reason ?? rationale;
}

function evidenceConfidenceOf(body: Record<string, unknown> | null): unknown {
  const ev = body?.decision_evidence;
  return ev && typeof ev === "object" ? (ev as { confidence?: unknown }).confidence : undefined;
}

export async function buildBriefs(
  tenantId: string,
  decisions: BriefableDecision[],
): Promise<Map<string, DecisionBrief>> {
  const out = new Map<string, DecisionBrief>();
  if (decisions.length === 0) return out;

  let measuredOutcomes: MeasuredOutcome[] = [];
  try {
    const sc = serviceClient();
    const { data, error } = await sc
      .from("action_outcomes")
      .select("action_class, decision_outcome, delta_metrics")
      .eq("tenant_id", tenantId)
      .eq("reconcile_status", "measured")
      .like("action_class", "meta_ads.%")
      .limit(1000);
    if (!error) measuredOutcomes = (data ?? []) as MeasuredOutcome[];
  } catch (e) {
    console.warn("proposal brief: action_outcomes read failed", (e as Error).message);
  }

  const wantsTrend = decisions.some((d) => campaignIdOf(d.body) !== null);
  const metricsByWindow: Record<string, CampaignMetric[]> = {};
  if (wantsTrend) {
    const ctx: ToolContext = { tenant_id: tenantId, log: () => {}, agent_slug: "performance-marketer" };
    await Promise.all(
      TREND_WINDOWS.map(async (w) => {
        try {
          const res = (await metaListCampaignsTool.execute(ctx, {
            date_preset: w.window,
            status: "ALL",
          })) as { campaigns?: Array<Record<string, unknown>> };
          metricsByWindow[w.window] = (res.campaigns ?? []).map((c) => ({
            campaign_id: String(c.campaign_id ?? ""),
            spend: typeof c.spend_usd === "number" ? c.spend_usd : null,
            roas: typeof c.roas === "number" ? c.roas : null,
          }));
        } catch {
          metricsByWindow[w.window] = [];
        }
      }),
    );
  }

  for (const d of decisions) {
    const brief = assembleBrief({
      actionClass: d.decision_class,
      campaignId: campaignIdOf(d.body),
      measuredOutcomes,
      metricsByWindow,
      evidenceConfidence: evidenceConfidenceOf(d.body),
      reasoningText: reasoningOf(d.body),
    });
    if (brief) out.set(d.id, brief);
  }
  return out;
}

export async function agentProposals(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  if (slug !== "performance-marketer") {
    res.json({ agent_slug: slug, buckets: [], total: 0, triage_focus: false });
    return;
  }

  const triageFocus = await isAdsManagerTriageFocusEnabled();

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("decisions")
    .select("id, agent_run_id, decision_class, handler, body, status, emitted_at")
    .eq("status", "proposed")
    .like("decision_class", "meta_ads.%")
    .order("emitted_at", { ascending: false });

  if (error) {
    res
      .status(500)
      .json({ error: { code: "query_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as DecisionRow[];
  const decisionIds = rows.map((r) => r.id);
  const revisionByDecision = new Map<string, RevisionRow>();
  const runById = new Map<string, RunRow>();
  const replacementsByRunId = new Map<string, ReplacementRow[]>();
  let hiddenDecisionIds = new Set<string>();

  if (decisionIds.length > 0) {
    const { data: revs } = await supabase
      .from("decision_revision_requests")
      .select("id, decision_id, agent_run_id, thread_id, status, message, original_decision_class, original_handler, original_body, assistant_text, replacement_decision_id, last_error, created_at")
      .in("decision_id", decisionIds)
      .order("created_at", { ascending: false });
    for (const r of (revs ?? []) as RevisionRow[]) {
      if (!revisionByDecision.has(r.decision_id)) revisionByDecision.set(r.decision_id, r);
    }

    const runIds = [...new Set((revs ?? []).map((r) => (r as RevisionRow).agent_run_id).filter((x): x is string => !!x))];
    if (runIds.length > 0) {
      const [{ data: runs }, { data: replacements }] = await Promise.all([
        supabase.from("agent_runs").select("id, status, payload").in("id", runIds),
        supabase
          .from("decisions")
          .select("id, agent_run_id, decision_class, body, status, emitted_at")
          .in("agent_run_id", runIds)
          .like("decision_class", "meta_ads.%")
          .order("emitted_at", { ascending: false }),
      ]);
      for (const r of (runs ?? []) as RunRow[]) runById.set(r.id, r);
      for (const d of (replacements ?? []) as ReplacementRow[]) {
        if (d.agent_run_id) {
          const arr = replacementsByRunId.get(d.agent_run_id) ?? [];
          arr.push(d);
          replacementsByRunId.set(d.agent_run_id, arr);
        }
      }
    }
    try {
      hiddenDecisionIds = await reconcileRevisions(
        auth.tenant_id,
        [...revisionByDecision.values()],
        runById,
        replacementsByRunId,
      );
    } catch (e) {
      console.warn(
        "decision revision reconciliation failed; serving unreconciled proposals",
        (e as Error).message,
      );
      hiddenDecisionIds = new Set<string>();
    }
  }

  const grouped: Record<BucketKey, DecisionRow[]> = {
    pause: [],
    budget_down: [],
    budget_up: [],
    resume: [],
    new: [],
    other: [],
  };
  const visibleRows: DecisionRow[] = [];
  for (const r of rows) {
    if (!hiddenDecisionIds.has(r.id)) {
      grouped[bucketFor(r.decision_class, r.body)].push(r);
      visibleRows.push(r);
    }
  }

  let briefs = new Map<string, DecisionBrief>();
  if (triageFocus && visibleRows.length > 0) {
    briefs = await buildBriefs(
      auth.tenant_id,
      visibleRows.map((r) => ({ id: r.id, decision_class: r.decision_class, body: r.body })),
    );
  }

  const buckets = BUCKET_ORDER.filter((b) => grouped[b.key].length > 0).map((b) => ({
    key: b.key,
    label: b.label,
    items: grouped[b.key].map((r) => ({
      id: r.id,
      agent_run_id: r.agent_run_id,
      decision_class: r.decision_class,
      handler: r.handler,
      body: r.body ?? {},
      status: r.status,
      emitted_at: r.emitted_at,
      revision: publicRevisionStatus(revisionView(revisionByDecision.get(r.id), runById, replacementsByRunId)),
      brief: briefs.get(r.id) ?? null,
    })),
  }));

  const recentConversations: Array<{
    id: string;
    decision_class: string;
    handler: string | null;
    body: Record<string, unknown>;
    decision_status: string;
    last_message: string;
    last_at: string;
  }> = [];
  try {
    const svc = serviceClient();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: myRevs } = await svc
      .from("decision_revision_requests")
      .select("decision_id, message, created_at")
      .eq("tenant_id", auth.tenant_id)
      .eq("created_by", auth.user_id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(60);
    const proposedIds = new Set(rows.map((r) => r.id));
    const latestByDecision = new Map<string, { message: string; created_at: string }>();
    for (const rv of (myRevs ?? []) as Array<{ decision_id: string; message: string; created_at: string }>) {
      if (proposedIds.has(rv.decision_id)) continue;
      if (!latestByDecision.has(rv.decision_id)) {
        latestByDecision.set(rv.decision_id, { message: rv.message, created_at: rv.created_at });
      }
    }
    const convoIds = [...latestByDecision.keys()].slice(0, 20);
    if (convoIds.length > 0) {
      const { data: decs } = await svc
        .from("decisions")
        .select("id, decision_class, handler, body, status")
        .eq("tenant_id", auth.tenant_id)
        .in("id", convoIds);
      const decById = new Map(
        ((decs ?? []) as Array<{ id: string; decision_class: string; handler: string | null; body: Record<string, unknown> | null; status: string }>).map(
          (d) => [d.id, d] as const,
        ),
      );
      for (const id of convoIds) {
        const d = decById.get(id);
        const last = latestByDecision.get(id);
        if (!d || !last) continue;
        recentConversations.push({
          id,
          decision_class: d.decision_class,
          handler: d.handler ?? null,
          body: (d.body ?? {}) as Record<string, unknown>,
          decision_status: d.status,
          last_message: last.message,
          last_at: last.created_at,
        });
      }
      recentConversations.sort((a, b) => b.last_at.localeCompare(a.last_at));
    }
  } catch (e) {
    console.warn("recent modify conversations load failed", (e as Error).message);
  }

  res.json({
    agent_slug: slug,
    buckets,
    total: rows.length - hiddenDecisionIds.size,
    recent_conversations: recentConversations,
    triage_focus: triageFocus,
  });
}
