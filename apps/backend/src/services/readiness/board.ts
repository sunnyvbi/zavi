
import { staffCrossTenantClient } from "@/services/tenant-client";
import { isLiveStorePlan } from "@/services/billing/store-rail";
import { READINESS_OPERABLE, shouldRunDiscovery } from "./should-run-discovery";

export type Lane = "act" | "nurture" | "operable" | "unscored";

const TRACTION_KEYS = new Set(["weekly_signups", "weekly_bookings", "stripe_mrr"]);

export interface BoardRow {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  company_shape: string | null;

  score: number | null;
  dimensions: Record<string, unknown> | null;
  subscores: Subscores | null;
  computed_at: string | null;
  last_discovery_at: string | null;

  lane: Lane;
  top_gap: string | null;
  connector_gap: boolean;
  agent_addressable: boolean;
  park_reason: string;

  plan: string | null;
  sub_status: string | null;
  paying: boolean;
  grandfathered: boolean;
  churn_signal: string | null;

  traction:
    | { status: "measured"; metric_key: string; value: number; window_end: string }
    | { status: "absent" };

  fde_touches: number;
  last_fde_touch_at: string | null;
}

export interface DecisiveAction {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  gap_dimension: string | null;
  action: string;
  why: string;
}

export interface BoardResponse {
  rows: BoardRow[];
  decisive: DecisiveAction | null;
  delegate: DecisiveAction | null;
  watch: DecisiveAction | null;
  evidence_rate: { status: "not_instrumented"; why: string };
  counts: { act: number; nurture: number; operable: number; unscored: number; total: number };
}

const DIMENSION_MAX: Record<string, number> = {
  connectors: 30,
  verified_brain: 20,
  goal_measurable: 15,
  deliverable: 15,
  product_url: 10,
  founder_engaged: 10,
};

const AGENT_DOABLE_DIMS = ["verified_brain", "product_url", "deliverable"] as const;
const HUMAN_DOABLE_DIMS = ["connectors", "goal_measurable", "founder_engaged"] as const;

export interface Subscores {
  agent_doable_score: number;
  agent_doable_max: number;
  agent_complete: boolean;
  human_doable_score: number;
  human_doable_max: number;
  human_blockers: string[];
}

export function subscores(dimensions: Record<string, unknown> | null): Subscores {
  const got = (dim: string): number =>
    dimensions && typeof dimensions[dim] === "number" ? (dimensions[dim] as number) : 0;

  const sum = (dims: readonly string[]) => ({
    score: dims.reduce((n, d) => n + got(d), 0),
    max: dims.reduce((n, d) => n + DIMENSION_MAX[d], 0),
  });

  const agent = sum(AGENT_DOABLE_DIMS);
  const human = sum(HUMAN_DOABLE_DIMS);
  const human_blockers = HUMAN_DOABLE_DIMS.filter((d) => got(d) < DIMENSION_MAX[d]);

  return {
    agent_doable_score: agent.score,
    agent_doable_max: agent.max,
    agent_complete: agent.score >= agent.max,
    human_doable_score: human.score,
    human_doable_max: human.max,
    human_blockers,
  };
}

const GAP_ACTION: Record<string, string> = {
  connectors:
    "Get their business systems connected — the biggest single scoring gap (30 pts). Find out WHY it is not connected: an OAuth they never clicked is 5 minutes; an unsupported system is a product decision. Do not assume it is a click.",
  verified_brain:
    "Correct the company brain by hand: confirm what the business actually is, from a source (their site, their press), and pin it. Unverified anchors are what let the fleet fabricate.",
  product_url:
    "Find and set the real product URL. Everything downstream (discovery, grounding) reads from it.",
  goal_measurable:
    "Sit with the founder and set ONE measurable goal. An unmeasurable goal stops the daily planner entirely.",
  deliverable:
    "Get one real deliverable in front of them. Not a memo — an artifact they would have paid for.",
  founder_engaged:
    "Reach out. Nothing else on this list matters if the founder has stopped showing up.",
};

export function topGap(dimensions: Record<string, unknown> | null): string | null {
  if (!dimensions) return null;
  let best: string | null = null;
  let bestDeficit = 0;
  for (const [dim, max] of Object.entries(DIMENSION_MAX)) {
    const got = typeof dimensions[dim] === "number" ? (dimensions[dim] as number) : null;
    if (got === null) continue;
    const deficit = max - got;
    if (
      deficit > bestDeficit ||
      (deficit === bestDeficit && best !== null && max > DIMENSION_MAX[best])
    ) {
      best = dim;
      bestDeficit = deficit;
    }
  }
  return bestDeficit > 0 ? best : null;
}

function compareAct(a: BoardRow, b: BoardRow): number {
  if (a.connector_gap !== b.connector_gap) return a.connector_gap ? -1 : 1;
  if (a.paying !== b.paying) return a.paying ? -1 : 1;

  const churnA = a.churn_signal !== null;
  const churnB = b.churn_signal !== null;
  if (churnA !== churnB) return churnA ? -1 : 1;

  const closenessA = READINESS_OPERABLE - (a.score ?? 0);
  const closenessB = READINESS_OPERABLE - (b.score ?? 0);
  if (closenessA !== closenessB) return closenessA - closenessB;

  const ta = a.last_fde_touch_at;
  const tb = b.last_fde_touch_at;
  if (ta === null && tb !== null) return -1;
  if (tb === null && ta !== null) return 1;
  if (ta !== null && tb !== null && ta !== tb) return ta < tb ? -1 : 1;

  return a.slug.localeCompare(b.slug);
}

const LANE_RANK: Record<Lane, number> = { act: 0, nurture: 1, unscored: 2, operable: 3 };

export function sortBoard(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    const laneDiff = LANE_RANK[a.lane] - LANE_RANK[b.lane];
    if (laneDiff !== 0) return laneDiff;
    if (a.lane === "act") return compareAct(a, b);
    const sa = a.score;
    const sb = b.score;
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    return a.slug.localeCompare(b.slug);
  });
}

export async function buildBoard(): Promise<BoardResponse> {
  const svc = staffCrossTenantClient("FDE cockpit: rank every tenant's onboarding readiness for staff triage");

  const { data: tenants, error: tErr } = await svc
    .from("tenants")
    .select("id, slug, display_name, company_shape")
    .eq("kind", "real");
  if (tErr) throw new Error(`board tenant read failed: ${tErr.message}`);

  const ids = (tenants ?? []).map((t) => (t as TenantRow).id);
  if (ids.length === 0) {
    return {
      rows: [],
      decisive: null,
      delegate: null,
      watch: null,
      evidence_rate: EVIDENCE_RATE_ABSENT,
      counts: { act: 0, nurture: 0, operable: 0, unscored: 0, total: 0 },
    };
  }

  const [readiness, subs, events, signals, conns, audits] = await Promise.all([
    svc.from("tenant_readiness").select("*").in("tenant_id", ids),
    svc
      .from("tenant_subscriptions")
      .select("tenant_id, plan, status, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, source")
      .in("tenant_id", ids),
    svc
      .from("fde_training_events")
      .select("tenant_id, created_at")
      .in("tenant_id", ids)
      .order("created_at", { ascending: false }),
    svc
      .from("tenant_metric_snapshots")
      .select("tenant_id, metric_key, value, window_end")
      .in("tenant_id", ids)
      .eq("status", "measured")
      .order("window_end", { ascending: false }),
    svc.from("tenant_mcp_servers").select("tenant_id, created_at").in("tenant_id", ids),
    svc
      .from("tenant_config_audit")
      .select("tenant_id, created_at")
      .eq("target", "tenant.product_url")
      .in("tenant_id", ids),
  ]);
  if (readiness.error) throw new Error(`board readiness read failed: ${readiness.error.message}`);
  if (subs.error) throw new Error(`board subscription read failed: ${subs.error.message}`);
  if (events.error) throw new Error(`board fde-events read failed: ${events.error.message}`);

  const snapshots = signals.error ? [] : ((signals.data ?? []) as MetricSnapshotRow[]);

  const rMap = new Map(
    (readiness.data ?? []).map((r) => [(r as ReadinessRow).tenant_id, r as ReadinessRow]),
  );
  const sMap = new Map((subs.data ?? []).map((s) => [(s as SubRow).tenant_id, s as SubRow]));

  const newestSignal = new Map<string, string>();
  for (const row of [...(conns.data ?? []), ...(audits.data ?? [])] as Array<{
    tenant_id: string;
    created_at: string;
  }>) {
    const cur = newestSignal.get(row.tenant_id);
    if (!cur || row.created_at > cur) newestSignal.set(row.tenant_id, row.created_at);
  }

  const touchCount = new Map<string, number>();
  const lastTouch = new Map<string, string>();
  for (const e of (events.data ?? []) as { tenant_id: string; created_at: string }[]) {
    touchCount.set(e.tenant_id, (touchCount.get(e.tenant_id) ?? 0) + 1);
    if (!lastTouch.has(e.tenant_id)) lastTouch.set(e.tenant_id, e.created_at);
  }

  const tractionMap = new Map<string, MetricSnapshotRow>();
  for (const s of snapshots) {
    if (!TRACTION_KEYS.has(s.metric_key)) continue;
    if (!tractionMap.has(s.tenant_id)) tractionMap.set(s.tenant_id, s);
  }

  const rows: BoardRow[] = (tenants ?? []).map((t) => {
    const tenant = t as TenantRow;
    const r = rMap.get(tenant.id) ?? null;
    const sub = sMap.get(tenant.id) ?? null;

    const score = r ? r.score : null;
    const dimensions = r?.dimensions ?? null;
    const gap = topGap(dimensions);

    const payingInStripe =
      !!sub &&
      !!sub.stripe_customer_id &&
      !!sub.stripe_subscription_id &&
      sub.plan !== "free" &&
      (sub.status === "active" || sub.status === "trialing");
    const payingInStore = !!sub && sub.plan !== "free" && isLiveStorePlan(sub);
    const paying = payingInStripe || payingInStore;

    const churn_signal = !sub
      ? null
      : sub.status === "past_due"
        ? "past_due"
        : sub.status === "canceled"
          ? "canceled"
          : sub.cancel_at_period_end
            ? "cancel_at_period_end"
            : null;

    const traction = tractionMap.get(tenant.id);

    let lane: Lane;
    let agent_addressable: boolean;
    let park_reason: string;

    if (score === null) {
      lane = "unscored";
      agent_addressable = false;
      park_reason = "readiness never computed — run the scan before triaging this tenant";
    } else {
      const decision = shouldRunDiscovery({
        score,
        last_discovery_at: r?.last_discovery_at ?? null,
        newest_signal_at: newestSignal.get(tenant.id) ?? null,
      });
      agent_addressable = decision.run;
      park_reason = decision.reason;

      if (score >= READINESS_OPERABLE) lane = "operable";
      else if (decision.run) lane = "nurture";
      else lane = "act";
    }

    return {
      tenant_id: tenant.id,
      slug: tenant.slug,
      display_name: tenant.display_name,
      company_shape: tenant.company_shape,
      score,
      dimensions,
      subscores: dimensions ? subscores(dimensions) : null,
      computed_at: r?.computed_at ?? null,
      last_discovery_at: r?.last_discovery_at ?? null,
      lane,
      top_gap: gap,
      connector_gap: gap === "connectors",
      agent_addressable,
      park_reason,
      plan: sub?.plan ?? null,
      sub_status: sub?.status ?? null,
      paying,
      grandfathered: false,
      churn_signal,
      traction: traction
        ? {
            status: "measured",
            metric_key: traction.metric_key,
            value: traction.value,
            window_end: traction.window_end,
          }
        : { status: "absent" },
      fde_touches: touchCount.get(tenant.id) ?? 0,
      last_fde_touch_at: lastTouch.get(tenant.id) ?? null,
    };
  });

  const sorted = sortBoard(rows);
  const act = sorted.filter((r) => r.lane === "act");

  const top = act[0] ?? null;
  const decisive: DecisiveAction | null = top
    ? {
        tenant_id: top.tenant_id,
        slug: top.slug,
        display_name: top.display_name,
        gap_dimension: top.top_gap,
        action: top.top_gap
          ? (GAP_ACTION[top.top_gap] ?? "Review this tenant by hand.")
          : "Review this tenant by hand.",
        why: decisiveWhy(top),
      }
    : null;

  const delegateRow = sorted.filter((r) => r.lane === "nurture" && r.agent_addressable)[0] ?? null;
  const delegate: DecisiveAction | null = delegateRow
    ? {
        tenant_id: delegateRow.tenant_id,
        slug: delegateRow.slug,
        display_name: delegateRow.display_name,
        gap_dimension: delegateRow.top_gap,
        action:
          "Dispatch the discovery agent — this tenant still has work an agent can do unattended. Do not spend a human hour here.",
        why: `Discovery is not parked (${delegateRow.park_reason}). Score ${fmtScore(delegateRow.score)}.`,
      }
    : null;

  const watchRow = sorted.filter((r) => r.lane === "operable" && r.churn_signal !== null)[0] ?? null;
  const watch: DecisiveAction | null = watchRow
    ? {
        tenant_id: watchRow.tenant_id,
        slug: watchRow.slug,
        display_name: watchRow.display_name,
        gap_dimension: null,
        action:
          "Watch — no setup work needed. This tenant is operable but its billing shows a churn signal.",
        why: `Billing state: ${watchRow.churn_signal}. Readiness ${fmtScore(watchRow.score)}. (A billing state, not a churn prediction.)`,
      }
    : null;

  return {
    rows: sorted,
    decisive,
    delegate,
    watch,
    evidence_rate: EVIDENCE_RATE_ABSENT,
    counts: {
      act: act.length,
      nurture: sorted.filter((r) => r.lane === "nurture").length,
      operable: sorted.filter((r) => r.lane === "operable").length,
      unscored: sorted.filter((r) => r.lane === "unscored").length,
      total: sorted.length,
    },
  };
}

function fmtScore(s: number | null): string {
  return s === null ? "not yet computed" : `${s}/100`;
}

function decisiveWhy(r: BoardRow): string {
  const bits: string[] = [];
  if (r.connector_gap) bits.push("missing a connector category — the biggest single score gain (30 pts)");
  if (r.paying) bits.push(`paying (${r.plan})`);
  if (r.churn_signal) bits.push(`billing shows ${r.churn_signal}`);
  if (r.score !== null) bits.push(`${READINESS_OPERABLE - r.score} pts from operable`);
  bits.push(
    r.fde_touches === 0
      ? "never been touched by a human"
      : `${r.fde_touches} prior FDE touch${r.fde_touches === 1 ? "" : "es"}`,
  );
  return bits.join("; ") + ". Discovery is parked here — an agent cannot move it.";
}

const EVIDENCE_RATE_ABSENT = {
  status: "not_instrumented",
  why: "No table records an external progress signal (customer reply, booked call, payment, shipped page). Readiness measures SETUP, not whether the business moved. Showing an agent-side proxy here would be a lie — an artifact produced is not a business moved.",
} as const;

interface TenantRow {
  id: string;
  slug: string;
  display_name: string | null;
  company_shape: string | null;
}
interface ReadinessRow {
  tenant_id: string;
  score: number;
  dimensions: Record<string, unknown>;
  computed_at: string;
  last_discovery_at: string | null;
}
interface SubRow {
  tenant_id: string;
  plan: string;
  status: string;
  cancel_at_period_end: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}
interface MetricSnapshotRow {
  tenant_id: string;
  metric_key: string;
  value: number;
  window_end: string;
}
