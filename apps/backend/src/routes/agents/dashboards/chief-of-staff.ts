import type { DashboardBuilder } from "./_contract";
import { GROWTH_PAGE_ONLY_NOT_IN } from "@/services/approvals/growth-page-only";
import { isMoneyOrAuthDecisionClass } from "./_attention-money";

const DISPATCH_SPECIALIST_CLASS = "chief-of-staff.dispatch-specialist";

const APPROVED_STATUSES = new Set(["approved", "acted", "dispatched"]);

const RECENT_VERDICTS_LIMIT = 8;
const ACCOUNTABILITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INTENT_CAP = 120;

function capText(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function intentFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const v = (body as Record<string, unknown>).intent;
  return typeof v === "string" ? v.trim() : "";
}

const REDACTED = "[redacted]";
const PII_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PII_SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const PII_CARD_RE = /\b(?:\d[ -]?){13,16}\b/g;
const PII_PHONE_RE = /(?:\+?\d[\d ().-]{8,}\d)/g;
const MONEY_RE = /\$\s?\d[\d,.]*\s?[kKmMbB]?/g;
function redactIntentForDisplay(s: string): string {
  if (!s) return "";
  return s
    .replace(PII_EMAIL_RE, REDACTED)
    .replace(PII_SSN_RE, REDACTED)
    .replace(PII_CARD_RE, REDACTED)
    .replace(PII_PHONE_RE, (m) =>
      (m.match(/\d/g)?.length ?? 0) >= 10 ? REDACTED : m,
    )
    .replace(MONEY_RE, REDACTED);
}

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
  decision_id?: string;
  is_money?: boolean;
};

type DispatchRow = {
  id: string;
  decision_class: string;
  target: string | null;
  status: string;
  autonomy_at_emit: string | null;
  emitted_at: string | null;
  dispatch_error: string | null;
};

type VerdictRow = {
  decision_id: string;
  verdict: "approved" | "rejected" | "deferred";
  target: string;
  intent: string;
  emitted_at: string | null;
};

type AccountabilityRow = {
  target: string;
  state: "delivered" | "on_track" | "at_risk" | "missed";
  intent: string;
  emitted_at: string | null;
};

function isFailed(status: string, dispatchError: string | null): boolean {
  return status === "failed" || !!dispatchError;
}

function targetFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const t = (body as Record<string, unknown>).target_agent_slug;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

function targetLabel(row: DispatchRow): string {
  return row.target ?? row.decision_class;
}

export const build: DashboardBuilder = async (c) => {
  let cosDecisions: Array<{
    id: string;
    decision_class: string;
    body: unknown;
    status: string;
    autonomy_at_emit: string | null;
    emitted_at: string | null;
    dispatched_at: string | null;
    dispatch_error: string | null;
  }> = [];
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, body, status, autonomy_at_emit, emitted_at, dispatched_at, dispatch_error")
      .eq("tenant_id", c.tenantId)
      .eq("decision_class", DISPATCH_SPECIALIST_CLASS)
      .order("emitted_at", { ascending: false })
      .limit(100);
    if (!error && data) {
      cosDecisions = data as typeof cosDecisions;
    }
  } catch {
    cosDecisions = [];
  }

  const dispatches: DispatchRow[] = cosDecisions.map((d) => ({
    id: d.id,
    decision_class: d.decision_class,
    target: targetFromBody(d.body),
    status: d.status,
    autonomy_at_emit: d.autonomy_at_emit,
    emitted_at: d.emitted_at,
    dispatch_error: d.dispatch_error,
  }));

  const pendingCosDispatches = dispatches.filter(
    (d) => d.status === "proposed" && d.autonomy_at_emit === "approval",
  ).length;

  let pendingApprovalsAll = 0;
  try {
    const { count, error } = await c.sb
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", c.tenantId)
      .eq("status", "proposed")
      .eq("autonomy_at_emit", "approval")
      .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN);
    if (!error && typeof count === "number") pendingApprovalsAll = count;
  } catch {
    pendingApprovalsAll = 0;
  }

  let lastDigestAt: string | null = null;
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("finished_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "chief-of-staff")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1);
    if (!error && data && data.length > 0) {
      lastDigestAt = (data[0].finished_at as string | null) ?? null;
    }
  } catch {
    lastDigestAt = null;
  }

  let specialistRunsSinceDigest = 0;
  if (lastDigestAt) {
    try {
      const { count, error } = await c.sb
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", c.tenantId)
        .eq("status", "success")
        .gt("finished_at", lastDigestAt)
        .neq("agent_slug", "chief-of-staff");
      if (!error && typeof count === "number") specialistRunsSinceDigest = count;
    } catch {
      specialistRunsSinceDigest = 0;
    }
  }

  const attention: AttentionItem[] = [];

  for (const d of dispatches) {
    if (isFailed(d.status, d.dispatch_error)) {
      const to = targetLabel(d);
      attention.push({
        severity: "high",
        title: `Dispatch to ${to} failed`,
        detail: d.dispatch_error
          ? `The queued dispatch didn't land (${d.dispatch_error}).`
          : "The queued dispatch is marked failed and never ran.",
        ask: `Re-queue the failed dispatch to ${to}.`,
      });
    }
  }

  for (const d of dispatches) {
    if (d.status === "proposed" && d.autonomy_at_emit === "approval") {
      const to = targetLabel(d);
      attention.push({
        severity: "warn",
        title: `Dispatch to ${to} is waiting on you`,
        detail:
          "Chief of staff queued this dispatch — it won't run until you approve it.",
        ask: `Approve the dispatch you queued to ${to}.`,
        decision_id: d.id,
        is_money: isMoneyOrAuthDecisionClass(d.decision_class),
      });
    }
  }

  if (lastDigestAt && specialistRunsSinceDigest === 0) {
    attention.push({
      severity: "warn",
      title: "No fleet activity since your last digest",
      detail:
        "Nothing you flagged got acted on since the last digest — the loop is still open.",
      ask: "Re-surface the most important open item from your last digest.",
    });
  }

  const attentionCapped = attention.slice(0, 8);

  const inFlight = dispatches.slice(0, 25).map((d) => ({
    target: targetLabel(d),
    decision_class: d.decision_class,
    status: d.status,
    emitted_at: d.emitted_at,
    dispatch_error: d.dispatch_error,
    failed: isFailed(d.status, d.dispatch_error),
  }));

  const dispatchSpecialistDecisions = cosDecisions.filter(
    (d) => d.decision_class === DISPATCH_SPECIALIST_CLASS,
  );

  const { recentVerdicts, accountability } = await buildAccountabilityPanels(
    c,
    dispatchSpecialistDecisions,
  );

  return {
    kpis: {
      pending_cos_dispatches: pendingCosDispatches,
      pending_approvals_all: pendingApprovalsAll,
      specialist_runs_since_digest: specialistRunsSinceDigest,
      last_digest_at: lastDigestAt,
    },
    has_digest: !!lastDigestAt,
    attention: attentionCapped,
    dispatches: inFlight,
    recent_verdicts: recentVerdicts,
    accountability,
  };
};

async function buildAccountabilityPanels(
  c: Parameters<DashboardBuilder>[0],
  dispatchDecisions: Array<{
    id: string;
    body: unknown;
    status: string;
    emitted_at: string | null;
    dispatched_at: string | null;
    dispatch_error: string | null;
  }>,
): Promise<{
  recentVerdicts: VerdictRow[];
  accountability: AccountabilityRow[];
}> {
  const recentVerdicts: VerdictRow[] = dispatchDecisions
    .filter((d) => d.status !== "proposed")
    .slice(0, RECENT_VERDICTS_LIMIT)
    .map((d) => {
      const verdict: VerdictRow["verdict"] =
        d.status === "rejected"
          ? "rejected"
          : d.status === "expired"
            ? "deferred"
            : "approved";
      return {
        decision_id: d.id,
        verdict,
        target: targetFromBody(d.body) ?? "(unknown)",
        intent: capText(redactIntentForDisplay(intentFromBody(d.body)), INTENT_CAP),
        emitted_at: d.emitted_at,
      };
    });

  const windowFloor = Date.now() - ACCOUNTABILITY_WINDOW_MS;
  const approvedInWindow = dispatchDecisions.filter((d) => {
    if (!APPROVED_STATUSES.has(d.status)) return false;
    const ts = d.emitted_at ? Date.parse(d.emitted_at) : NaN;
    return Number.isFinite(ts) && ts >= windowFloor;
  });

  if (approvedInWindow.length === 0) {
    return { recentVerdicts, accountability: [] };
  }

  const decisionIds = approvedInWindow.map((d) => d.id);
  const runByDecisionId = new Map<string, { status: string }>();
  try {
    const { data: runRows, error } = await c.sb
      .from("agent_runs")
      .select("status, payload")
      .eq("tenant_id", c.tenantId)
      .in("payload->>source_decision_id", decisionIds);
    if (!error && runRows) {
      for (const r of runRows as Array<{ status: unknown; payload: unknown }>) {
        const sdid =
          r.payload && typeof r.payload === "object"
            ? (r.payload as { source_decision_id?: unknown }).source_decision_id
            : undefined;
        if (typeof sdid === "string" && sdid && !runByDecisionId.has(sdid)) {
          runByDecisionId.set(sdid, { status: String(r.status ?? "") });
        }
      }
    }
  } catch {
  }

  const order: AccountabilityRow["state"][] = [
    "delivered",
    "on_track",
    "at_risk",
    "missed",
  ];
  const worstIdx = (a: AccountabilityRow["state"], b: AccountabilityRow["state"]) =>
    order.indexOf(a) >= order.indexOf(b) ? a : b;

  const byTarget = new Map<string, AccountabilityRow>();
  for (const d of approvedInWindow) {
    const target = targetFromBody(d.body) ?? "(unknown)";
    const run = runByDecisionId.get(d.id);
    let state: AccountabilityRow["state"];
    if (run?.status === "success") {
      state = "delivered";
    } else if (run?.status === "running" || run?.status === "queued") {
      state = "on_track";
    } else if (run && run.status) {
      state = "missed";
    } else {
      state = "at_risk";
    }
    const intent = capText(redactIntentForDisplay(intentFromBody(d.body)), INTENT_CAP);
    const existing = byTarget.get(target);
    if (!existing) {
      byTarget.set(target, { target, state, intent, emitted_at: d.emitted_at });
    } else {
      const newer =
        (d.emitted_at ? Date.parse(d.emitted_at) : 0) >
        (existing.emitted_at ? Date.parse(existing.emitted_at) : 0);
      byTarget.set(target, {
        target,
        state: worstIdx(existing.state, state),
        intent: newer ? intent : existing.intent,
        emitted_at: newer ? d.emitted_at : existing.emitted_at,
      });
    }
  }

  const accountability = [...byTarget.values()].sort(
    (a, b) => order.indexOf(b.state) - order.indexOf(a.state),
  );

  return { recentVerdicts, accountability };
}
