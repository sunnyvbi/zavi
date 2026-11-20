
import { createHash } from "node:crypto";
import type { ActiveAdBudget } from "@/services/decisions/ad-budget";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type BudgetReviewFacts = {
  budget: string;
  holds: string[];
  cards_open: string[];
  cards_in_flight: string[];
  decisions_open: string[];
  decisions_in_flight: string[];
  exec_failed: number;
  dispatch_failed: number;
  due_tests: string[];
  answered: string | null;
  plan: string | null;
  incidents: string[];
  ad_change: string | null;
  goals: string[];
  campaigns: string[];
};

const cents = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null);

export function budgetFact(b: ActiveAdBudget): string {
  return [
    b.id,
    cents(b.monthly_usd),
    cents(b.month_cap_usd),
    cents(b.spent_usd),
    cents(b.creator_held_usd),
    cents(b.creator_spent_usd),
    cents(b.daily_limit_usd),
    b.margin ?? "",
    b.next_month_start,
  ].join(":");
}

export function budgetReviewSignature(f: BudgetReviewFacts): string {
  const stable = {
    budget: f.budget,
    holds: [...f.holds].sort(),
    cards_open: [...f.cards_open].sort(),
    cards_in_flight: [...f.cards_in_flight].sort(),
    decisions_open: [...f.decisions_open].sort(),
    decisions_in_flight: [...f.decisions_in_flight].sort(),
    exec_failed: f.exec_failed,
    dispatch_failed: f.dispatch_failed,
    due_tests: [...f.due_tests].sort(),
    answered: f.answered,
    plan: f.plan,
    incidents: [...f.incidents].sort(),
    ad_change: f.ad_change,
    goals: [...f.goals].sort(),
    campaigns: [...f.campaigns].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

type CountResult = { count: number | null; error: { message: string } | null };

function counted(what: string, r: CountResult): number {
  if (r.error) throw new Error(`budget-review-signature: ${what} count failed: ${r.error.message}`);
  return r.count ?? 0;
}

const LIST_MAX = 500;
const CAMPAIGNS_MAX = 999;

type Rows<T> = { data: T[] | null; error: { message: string } | null };

function rows<T>(what: string, r: Rows<T>, max: number = LIST_MAX): T[] {
  if (r.error) throw new Error(`budget-review-signature: ${what} read failed: ${r.error.message}`);
  const data = r.data ?? [];
  if (data.length > max) throw new Error(`budget-review-signature: ${what} has more than ${max} rows; not hashed`);
  return data;
}

const ids = (what: string, r: Rows<{ id: string }>) => rows(what, r).map((x) => x.id);

export async function readBudgetReviewFacts(tenant_id: string, budget: ActiveAdBudget, now: Date = new Date()): Promise<BudgetReviewFacts> {
  const svc = tenantClient(asTenantId(tenant_id));
  const head = { count: "exact" as const, head: true };
  const [{ readDueTests }, { CGO_CARD_CLASS }] = await Promise.all([import("./cgo-tests"), import("./goal-owner")]);
  const [holds, cardsOpen, cardsFlight, decOpen, decFlight, execFailed, dispatchFailed, due, answered, plan, incidents, adChange, goals, campaigns] =
    await Promise.all([
      svc.from("ad_budget_reservations").select("id, status, paused, bounded, daily_delta_usd").eq("tenant_id", tenant_id).eq("budget_id", budget.id).in("status", ["reserved", "committed"]).order("id").limit(LIST_MAX + 1),
      svc.from("channel_actions").select("id").eq("tenant_id", tenant_id).eq("status", "pending").is("exec_status", null).order("id").limit(LIST_MAX + 1),
      svc.from("channel_actions").select("id").eq("tenant_id", tenant_id).eq("status", "pending").in("exec_status", ["queued", "dispatching"]).order("id").limit(LIST_MAX + 1),
      svc.from("decisions").select("id").eq("tenant_id", tenant_id).eq("status", "proposed").order("id").limit(LIST_MAX + 1),
      svc.from("decisions").select("id").eq("tenant_id", tenant_id).in("status", ["approved", "dispatching"]).order("id").limit(LIST_MAX + 1),
      svc.from("channel_actions").select("id", head).eq("tenant_id", tenant_id).eq("exec_status", "failed"),
      svc.from("decisions").select("id", head).eq("tenant_id", tenant_id).in("status", ["dispatch_failed", "failed"]),
      readDueTests(tenant_id, CGO_CARD_CLASS, now),
      svc.from("cgo_questions").select("id, answered_at").eq("tenant_id", tenant_id).eq("status", "answered").order("answered_at", { ascending: false }).limit(1),
      svc.from("growth_plan").select("id, version, updated_at").eq("tenant_id", tenant_id).eq("status", "live").limit(1),
      svc.from("metric_incidents").select("id, status").eq("tenant_id", tenant_id).neq("status", "recovered").order("id").limit(LIST_MAX + 1),
      svc.from("ad_object_changes").select("id, occurred_at").eq("tenant_id", tenant_id).order("occurred_at", { ascending: false }).limit(1),
      svc.from("autopilot_goals").select("id, target_metric, target_value, due_date").eq("tenant_id", tenant_id).eq("status", "active").order("id").limit(LIST_MAX + 1),
      svc.from("ad_campaigns").select("platform, object_id, status, budget_kind, budget_usd, campaign_budget_usd").eq("tenant_id", tenant_id).order("platform").order("object_id").limit(CAMPAIGNS_MAX + 1),
    ]);
  const planRow = rows("plan", plan as Rows<{ id: string; version: number | null; updated_at: string | null }>)[0];
  const changeRow = rows("ad change", adChange as Rows<{ id: string; occurred_at: string | null }>)[0];
  const answerRow = rows("answered question", answered as Rows<{ id: string; answered_at: string | null }>)[0];
  return {
    budget: budgetFact(budget),
    holds: rows("holds", holds as Rows<{ id: string; status: string; paused: boolean | null; bounded: boolean | null; daily_delta_usd: number | null }>).map(
      (h) => `${h.id}:${h.status}:${h.paused ? 1 : 0}:${h.bounded ? 1 : 0}:${cents(Number(h.daily_delta_usd))}`,
    ),
    cards_open: ids("open cards", cardsOpen as Rows<{ id: string }>),
    cards_in_flight: ids("in-flight cards", cardsFlight as Rows<{ id: string }>),
    decisions_open: ids("open decisions", decOpen as Rows<{ id: string }>),
    decisions_in_flight: ids("in-flight decisions", decFlight as Rows<{ id: string }>),
    exec_failed: counted("exec failures", execFailed as CountResult),
    dispatch_failed: counted("dispatch failures", dispatchFailed as CountResult),
    due_tests: [...due.due.map((d) => d.decision_id), ...(due.more > 0 ? [`more:${due.more}`] : [])],
    answered: answerRow ? `${answerRow.id}:${answerRow.answered_at ?? ""}` : null,
    plan: planRow ? `${planRow.id}:${planRow.version ?? ""}:${planRow.updated_at ?? ""}` : null,
    incidents: rows("incidents", incidents as Rows<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`),
    ad_change: changeRow ? `${changeRow.id}:${changeRow.occurred_at ?? ""}` : null,
    goals: rows("goals", goals as Rows<{ id: string; target_metric: string | null; target_value: number | null; due_date: string | null }>).map(
      (g) => `${g.id}:${g.target_metric ?? ""}:${g.target_value ?? ""}:${g.due_date ?? ""}`,
    ),
    campaigns: rows(
      "campaigns",
      campaigns as Rows<{ platform: string; object_id: string; status: string | null; budget_kind: string | null; budget_usd: number | null; campaign_budget_usd: number | null }>,
      CAMPAIGNS_MAX,
    ).map((c) => {
      const usd = (v: number | null) => cents(v == null ? null : Number(v));
      return `${c.platform}:${c.object_id}:${c.status ?? ""}:${c.budget_kind ?? ""}:${usd(c.budget_usd)}:${usd(c.campaign_budget_usd)}`;
    }),
  };
}

export async function currentBudgetSignature(tenant_id: string, budget: ActiveAdBudget, now: Date = new Date()): Promise<string> {
  return budgetReviewSignature(await readBudgetReviewFacts(tenant_id, budget, now));
}

export async function signatureForPayload(tenant_id: string, now: Date): Promise<string | null> {
  try {
    const { cgoAdBudget } = await import("./cgo-ads");
    const budget = await cgoAdBudget(tenant_id, now);
    return budget ? await currentBudgetSignature(tenant_id, budget, now) : null;
  } catch (e) {
    console.warn(
      JSON.stringify({ event: "cgo.budget_signature.write_failed", tenant_id, error: (e as Error).message.slice(0, 300) }),
    );
    return null;
  }
}

export async function readLastReview(tenant_id: string, stage: string): Promise<{ status: string; signature: string | null; enqueued_at: string | null } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("status, payload, enqueued_at")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "cgo")
    .eq("payload->>stage", stage)
    .order("enqueued_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`budget-review-signature: last review read failed: ${error.message}`);
  const row = ((data ?? []) as Array<{ status: string; payload: Record<string, unknown> | null; enqueued_at?: string | null }>)[0];
  if (!row) return null;
  const sig = row.payload?.budget_signature;
  return { status: row.status, signature: typeof sig === "string" && sig.length > 0 ? sig : null, enqueued_at: row.enqueued_at ?? null };
}

export function nothingChangedSince(last: { status: string; signature: string | null } | null, current: string): boolean {
  return !!last && last.status === "success" && last.signature !== null && last.signature === current;
}
