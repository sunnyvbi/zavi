import type { DashboardBuilder } from "./_contract";
import { stripeClient } from "@/services/tools/stripe/_client";

type Reason =
  | "fraudulent"
  | "duplicate"
  | "product_unacceptable"
  | "product_not_received"
  | string;

export type Ce3Status = "qualified" | "requires_action" | "not_qualified" | "n/a";

type OpenDispute = {
  id: string;
  amount_usd: number;
  currency: string;
  reason: Reason;
  due_by: number | null;
  past_due: boolean;
  has_evidence: boolean;
  submission_count: number;
  ce3_status: Ce3Status;
  ce3_required_actions: string[];
};

type ReasonBucket = {
  reason: Reason;
  count: number;
  total_usd: number;
  won: number;
  resolved: number;
  win_rate: number | null;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function humanizeReason(reason: Reason): string {
  switch (reason) {
    case "fraudulent":
      return "Fraud (Visa 10.4)";
    case "duplicate":
      return "Duplicate";
    case "product_unacceptable":
      return "Product unacceptable";
    case "product_not_received":
      return "Not received";
    default:
      return String(reason || "Other").replace(/_/g, " ");
  }
}

function countdownText(dueBy: number | null, pastDue: boolean): string {
  if (pastDue) return "now (past due)";
  if (dueBy == null) return "soon (no deadline set)";
  const secs = dueBy - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "now (past due)";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days >= 1) return `${days}d ${hours}h`;
  const mins = Math.floor((secs % 3600) / 60);
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function humanizeCe3Action(action: string): string {
  switch (action) {
    case "missing_customer_identifiers":
      return "Add customer identifiers (email / IP / device)";
    case "missing_disputed_transaction_description":
      return "Describe the disputed transaction";
    case "missing_merchandise_or_services":
      return "Specify the merchandise or services";
    case "missing_prior_undisputed_transaction_description":
      return "Describe a prior undisputed transaction";
    case "missing_prior_undisputed_transactions":
      return "Add 2+ prior undisputed transactions (120–365d old)";
    default:
      return String(action || "").replace(/_/g, " ");
  }
}

type Ce3Eligibility = {
  status?: string;
  required_actions?: string[];
};
export type StripeDisputeLite = {
  id: string;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  evidence_details?: {
    due_by?: number | null;
    past_due?: boolean;
    has_evidence?: boolean;
    submission_count?: number;
    enhanced_eligibility?: {
      visa_compelling_evidence_3?: Ce3Eligibility | null;
    } | null;
  } | null;
};

export function readCe3(d: StripeDisputeLite): {
  status: Ce3Status;
  required_actions: string[];
} {
  const ce3 =
    d.evidence_details?.enhanced_eligibility?.visa_compelling_evidence_3;
  const raw = ce3?.status;
  const status: Ce3Status =
    raw === "qualified" || raw === "requires_action" || raw === "not_qualified"
      ? raw
      : "n/a";
  const actions = Array.isArray(ce3?.required_actions)
    ? ce3!.required_actions.map(humanizeCe3Action).filter(Boolean)
    : [];
  return { status, required_actions: actions };
}

export const build: DashboardBuilder = async (c) => {
  let stripe: Awaited<ReturnType<typeof stripeClient>>;
  try {
    stripe = await stripeClient(c.tenantId);
  } catch {
    return { connected: false };
  }

  let openRaw: StripeDisputeLite[] = [];
  try {
    const res = (await stripe.disputes.list({
      limit: 100,
    })) as unknown as { data?: StripeDisputeLite[] };
    openRaw = (res.data ?? []).filter(
      (d) =>
        d.status === "needs_response" ||
        d.status === "warning_needs_response",
    );
  } catch {
    return { connected: false };
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const open: OpenDispute[] = openRaw.map((d) => {
    const dueBy =
      typeof d.evidence_details?.due_by === "number"
        ? d.evidence_details.due_by
        : null;
    const pastDue =
      d.evidence_details?.past_due === true ||
      (dueBy != null && dueBy <= nowSecs);
    const ce3 = readCe3(d);
    return {
      id: d.id,
      amount_usd: round2((Number(d.amount) || 0) / 100),
      currency: String(d.currency || "usd").toUpperCase(),
      reason: d.reason,
      due_by: dueBy,
      past_due: pastDue,
      has_evidence: d.evidence_details?.has_evidence === true,
      submission_count:
        typeof d.evidence_details?.submission_count === "number"
          ? d.evidence_details.submission_count
          : 0,
      ce3_status: ce3.status,
      ce3_required_actions: ce3.required_actions,
    };
  });

  open.sort((a, b) => {
    if (a.due_by == null && b.due_by == null) return 0;
    if (a.due_by == null) return 1;
    if (b.due_by == null) return -1;
    return a.due_by - b.due_by;
  });

  const openCount = open.length;
  const amountAtRisk = round2(open.reduce((s, d) => s + d.amount_usd, 0));

  let recentRaw: StripeDisputeLite[] = [];
  try {
    const res = (await stripe.disputes.list({
      created: { gte: nowSecs - 90 * 86400 },
      limit: 100,
    })) as unknown as { data?: StripeDisputeLite[] };
    recentRaw = res.data ?? [];
  } catch {
    recentRaw = [];
  }

  let won = 0;
  let lost = 0;
  let recoveredUsd = 0;
  for (const d of recentRaw) {
    if (d.status === "won") {
      won += 1;
      recoveredUsd += (Number(d.amount) || 0) / 100;
    } else if (d.status === "lost") {
      lost += 1;
    }
  }
  const resolved = won + lost;
  const winRate = resolved >= 5 ? round2(won / resolved) : null;
  const recovered = round2(recoveredUsd);

  const reasonMap = new Map<Reason, ReasonBucket>();
  const ensure = (reason: Reason): ReasonBucket => {
    let b = reasonMap.get(reason);
    if (!b) {
      b = {
        reason,
        count: 0,
        total_usd: 0,
        won: 0,
        resolved: 0,
        win_rate: null,
      };
      reasonMap.set(reason, b);
    }
    return b;
  };
  for (const d of open) {
    const b = ensure(d.reason);
    b.count += 1;
    b.total_usd = round2(b.total_usd + d.amount_usd);
  }
  for (const d of recentRaw) {
    if (d.status !== "won" && d.status !== "lost") continue;
    const b = ensure(d.reason);
    b.resolved += 1;
    if (d.status === "won") b.won += 1;
  }
  const byReason = Array.from(reasonMap.values())
    .map((b) => ({
      ...b,
      win_rate: b.resolved >= 1 ? round2(b.won / b.resolved) : null,
    }))
    .sort((a, b) => b.count - a.count || b.total_usd - a.total_usd);

  const attention: AttentionItem[] = [];
  const soonest = open[0];
  if (soonest) {
    const cd = countdownText(soonest.due_by, soonest.past_due);
    const dpShort = soonest.id.length > 12 ? `${soonest.id.slice(0, 12)}…` : soonest.id;
    attention.push({
      severity: soonest.past_due || (soonest.due_by != null && soonest.due_by - nowSecs < 72 * 3600)
        ? "high"
        : "warn",
      title: `Evidence due ${cd === "now (past due)" ? "now (past due)" : `in ${cd}`} for ${dpShort}`,
      detail: `$${soonest.amount_usd} ${soonest.currency} disputed as "${humanizeReason(soonest.reason)}". Submission to Stripe stays manual — draft the evidence, then file it from the Stripe dashboard.`,
      ask: `Draft the evidence for ${soonest.id} — due in ${cd}.`,
    });
  }

  return {
    connected: true,
    kpis: {
      open_count: openCount,
      amount_at_risk_usd: amountAtRisk,
      win_rate: winRate,
      resolved_count: resolved,
      recovered_usd: recovered,
    },
    open,
    by_reason: byReason,
    attention,
  };
};
