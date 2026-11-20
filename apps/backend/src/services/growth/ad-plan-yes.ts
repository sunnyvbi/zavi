import { asTenantId, tenantClient } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { adPlanAsk, adPlanBoundaries, shapeAdPlan, type AdPlan } from "./ad-plan-shape";
import { buildEnvelope, setApprovalEnvelope, utcToday, type Approver } from "@/services/approvals/approval-envelope";

export const YES_RUNNABLE_AD_CHANNELS = ["chatgpt_ads", "tiktok_ads"] as const;

export type AdPlanOnYes = { kind: "ad_plan"; goal_id: string; goal_rev: string; plan: AdPlan; card_id?: string };

export async function readConnectedAdChannels(tenant_id: string): Promise<string[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const out: string[] = [];
  try {
    const { previewChatgptAccount } = await import("@/services/ads-wallet/chatgpt-account-preview");
    await previewChatgptAccount(tenant_id);
    out.push("chatgpt_ads");
  } catch {
  }
  try {
    const { data } = await db.from("connector_metadata").select("team_id, selected_ad_account_id").eq("tenant_id", tenant_id).eq("slug", "composio.tiktok_ads").maybeSingle();
    const row = data as { team_id?: string | null; selected_ad_account_id?: string | null } | null;
    if (row?.team_id && row.selected_ad_account_id) out.push("tiktok_ads");
  } catch {
  }
  try {
    const { data } = await db.from("tenant_channels").select("channel_slug, plan_sort_order").eq("tenant_id", tenant_id).in("channel_slug", out);
    const order = new Map(((data ?? []) as Array<{ channel_slug: string; plan_sort_order: number | null }>).map((r) => [r.channel_slug, r.plan_sort_order ?? 1e9]));
    out.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  } catch {
  }
  return out;
}

export function adPlanReply(text: string | null | undefined, ordinal: number | null): { yes: true; amount_usd: number | null } | null {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const ord = /^(\d{1,2})\s*[.):-]?\s+/.exec(t);
  if (ord) {
    if (ordinal != null && Number(ord[1]) !== ordinal) return null;
    t = t.slice(ord[0].length);
  }
  const but = /^(yes|yep|yeah|ok|okay|sure|go ahead)\b[\s,.!]*(?:but|at|with|for|make it|only)?\s*\$\s?(\d{1,6}(?:\.\d{1,2})?)\s*(?:total|instead)?[.!]?\s*$/i.exec(t);
  if (but) {
    const n = Math.round(Number(but[2]) * 100) / 100;
    return n > 0 ? { yes: true, amount_usd: n } : null;
  }
  return replySaysYesSync(t) ? { yes: true, amount_usd: null } : null;
}

let replySaysYesRef: ((t: string) => boolean) | null = null;
function replySaysYesSync(t: string): boolean {
  if (!replySaysYesRef) throw new Error("adPlanReply: call loadReplyReader() first");
  return replySaysYesRef(t);
}
export async function loadReplyReader(): Promise<void> {
  if (!replySaysYesRef) replySaysYesRef = (await import("./founder-reply-approve")).replySaysYes;
}

export function reshapeForAmount(plan: AdPlan, amount_usd: number, today: string, days_left: number): AdPlan | null {
  const r = shapeAdPlan({ want_usd: amount_usd, left_usd: Infinity, days_left, margin: 1, today, preferred: plan.channel_slug, connected: [plan.channel_slug] });
  return r.kind === "plan" ? r.plan : null;
}

export type AdPlanYesDeps = {
  emitDecision: (decision_class: string, body: unknown) => Promise<string>;
  loadRole?: typeof loadTenantRoleFor;
  setEnvelope?: typeof setApprovalEnvelope;
  approve?: (tenant_id: string, decision_id: string, actor_user_id: string) => Promise<boolean>;
  existingCard?: (tenant_id: string, question_id: string) => Promise<string | null>;
  enabled?: () => Promise<boolean>;
};

async function existingCardFor(tenant_id: string, question_id: string): Promise<string | null> {
  const { data } = await tenantClient(asTenantId(tenant_id))
    .from("decisions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", "cgo.dispatch-specialist")
    .eq("body->>source_question_id", question_id)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

async function approveAsPerson(tenant_id: string, decision_id: string, actor_user_id: string): Promise<boolean> {
  const { decideOnDecision } = await import("@/services/approvals/decide-service");
  const r = await decideOnDecision({ decision_id, tenant_id, action: "approve", actor: { user_id: actor_user_id } });
  return r.ok;
}

export async function applyAdPlanYes(
  args: {
    tenant_id: string;
    question: { id: string; ordinal: number | null; on_yes: AdPlanOnYes };
    approver_user_id: string | null;
    surface: Approver["surface"];
    amount_usd: number | null;
    days_left: number;
    now: Date;
  },
  deps: AdPlanYesDeps,
): Promise<{ line: string | null; refused: string | null }> {
  const enabled = deps.enabled ?? (async () => (await import("./ads-no-friction-flag")).adsNoFrictionEnabled());
  if (!(await enabled())) return { line: null, refused: "ad plans are turned off" };
  if (!args.approver_user_id) return { line: null, refused: "An owner or admin needs to approve this." };
  let role: string | null;
  try {
    role = await (deps.loadRole ?? loadTenantRoleFor)(args.approver_user_id, args.tenant_id);
  } catch {
    return { line: null, refused: "the approver's role could not be read" };
  }
  if (role !== "owner" && role !== "admin") return { line: null, refused: "An owner or admin needs to approve this." };
  const today = utcToday(args.now);
  let plan = args.question.on_yes.plan;
  if (plan.start < today) plan = { ...plan, start: today, end: new Date(Date.parse(`${today}T00:00:00Z`) + plan.days * 86_400_000).toISOString().slice(0, 10) };
  if (args.amount_usd != null) {
    const re = reshapeForAmount(plan, args.amount_usd, today, Math.max(1, args.days_left));
    if (!re) return { line: null, refused: `$${args.amount_usd} cannot run on this channel` };
    plan = re;
  }
  const { goal_id, goal_rev } = args.question.on_yes;
  let card: string | null = null;
  try {
    card = await deps.emitDecision("cgo.dispatch-specialist", {
      target_agent_slug: plan.channel_slug,
      intent: `The founder approved this ad test. Build exactly this and propose it now: ${adPlanBoundaries(plan)}`.slice(0, 2000),
      dispatched_by: "cgo",
      source_agent: "cgo",
      goal_id,
      goal_rev,
      boundaries: adPlanBoundaries(plan).slice(0, 400),
      source_question_id: args.question.id,
    });
  } catch (e) {
    card = await (deps.existingCard ?? existingCardFor)(args.tenant_id, args.question.id).catch(() => null);
    if (!card) return { line: null, refused: `the card could not be filed: ${(e as Error).message}` };
  }
  if (!card) return { line: null, refused: "the card could not be filed" };
  const approver: Approver = { user_id: args.approver_user_id, role, surface: args.surface };
  const env = buildEnvelope({ envelope_id: `q:${args.question.id}`, tenant_id: args.tenant_id, approver, plan, surface: "cgo_yes", source_question_id: args.question.id });
  const set = await (deps.setEnvelope ?? setApprovalEnvelope)(args.tenant_id, "decisions", card, env);
  if (!set.ok && set.code !== "not_pending") return { line: null, refused: `the approval could not be recorded (${set.code ?? "refused"})` };
  if (set.ok && !(await (deps.approve ?? approveAsPerson)(args.tenant_id, card, args.approver_user_id))) {
    return { line: null, refused: "the card could not be approved" };
  }
  return { line: `Approved: ${adPlanAsk(plan).replace(/^Should I spend/, "spending").replace(/\?.*$/, "")}.`, refused: null };
}

export type BudgetRaiseOnYes = { kind: "budget_raise"; budget_id: string; to_usd: number };

const dollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function budgetRaiseAsk(view: { id: string; monthly_usd: number; month_cap_usd: number; left_usd: number; spent_usd: number; held_usd: number; creator_held_usd?: number; creator_spent_usd?: number }): import("./cgo-questions").QuestionAsk | null {
  const used = Math.round((view.spent_usd + view.held_usd + (view.creator_held_usd ?? 0) + (view.creator_spent_usd ?? 0)) * 100) / 100;
  if (!(used > view.month_cap_usd)) return null;
  const to = Math.ceil((view.monthly_usd + (used - view.month_cap_usd)) / 10) * 10;
  const onYes: BudgetRaiseOnYes = { kind: "budget_raise", budget_id: view.id, to_usd: to };
  return {
    required: true,
    topic_key: "ad_budget",
    ask: `That uses ${dollars(used)} of your ${dollars(view.monthly_usd)} monthly ad budget. Raise it to ${dollars(to)} so Autopilot can keep testing?`,
    default_action: null,
    recommended: "yes",
    on_yes: onYes as never,
  };
}

export async function askBudgetRaiseOnce(tenant_id: string, run_id: string | null, now = new Date()): Promise<void> {
  try {
    const { readActiveAdBudget } = await import("@/services/decisions/ad-budget");
    const view = await readActiveAdBudget(tenant_id);
    if (!view) return;
    const ask = budgetRaiseAsk(view);
    if (!ask) return;
    const { planQuestionsDetailed, readQuestions, insertQuestions } = await import("./cgo-questions");
    const plan = planQuestionsDetailed([ask], await readQuestions(tenant_id, now), now);
    await insertQuestions(tenant_id, run_id, plan.planned);
  } catch (e) {
    console.warn(`[ad-plan-yes] the raise question for ${tenant_id} was not asked: ${(e as Error).message}`);
  }
}

export async function applyBudgetRaiseYes(
  tenant_id: string,
  onYes: BudgetRaiseOnYes,
  approver_user_id: string | null,
  deps: { loadRole?: typeof loadTenantRoleFor; readBudget?: () => Promise<{ id: string; monthly_usd: number; daily_limit_usd: number | null } | null>; update?: (a: { actor: string; budget_id: string; monthly_usd: number; daily_limit_usd: number | null }) => Promise<boolean> } = {},
): Promise<{ line: string | null; refused: string | null }> {
  if (!approver_user_id) return { line: null, refused: "An owner or admin needs to approve this." };
  const role = await (deps.loadRole ?? loadTenantRoleFor)(approver_user_id, tenant_id).catch(() => null);
  if (role !== "owner" && role !== "admin") return { line: null, refused: "An owner or admin needs to approve this." };
  const budget = await (deps.readBudget ?? (async () => (await import("@/services/decisions/ad-budget")).readActiveAdBudget(tenant_id)))();
  if (!budget || budget.id !== onYes.budget_id) return { line: null, refused: "the ad budget changed since the question was asked" };
  if (budget.monthly_usd >= onYes.to_usd) return { line: `Your monthly ad budget is already ${dollars(budget.monthly_usd)}.`, refused: null };
  const update =
    deps.update ??
    (async (a: { actor: string; budget_id: string; monthly_usd: number; daily_limit_usd: number | null }) => {
      const { tenantRpc } = await import("@/services/tenant-client");
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "update_ad_budget", { p_actor: a.actor, p_budget_id: a.budget_id, p_monthly_usd: a.monthly_usd, p_daily_limit_usd: a.daily_limit_usd });
      return !error && (data as { status?: string } | null)?.status === "updated";
    });
  const ok = await update({ actor: approver_user_id, budget_id: budget.id, monthly_usd: onYes.to_usd, daily_limit_usd: budget.daily_limit_usd });
  return ok ? { line: `Your monthly ad budget is now ${dollars(onYes.to_usd)}.`, refused: null } : { line: null, refused: "the budget raise was refused" };
}

export async function envelopeFollowUps(tenant_id: string, now: Date): Promise<Array<{ text: string; action_id: string; channel_slug: string }>> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const { data, error } = await db
      .from("channel_actions")
      .select("id, channel_slug, exec_result, status_at")
      .eq("tenant_id", tenant_id)
      .eq("exec_status", "failed")
      .neq("status", "redone")
      .not("approval_envelope", "is", null)
      .gte("status_at", new Date(now.getTime() - 48 * 3_600_000).toISOString())
      .limit(10);
    if (error) return [];
    const { channelName } = await import("./ad-plan-shape");
    const lines = ((data ?? []) as Array<{ id: string; channel_slug: string; exec_result: { error?: unknown } | null }>).map((r) => ({
      action_id: r.id,
      channel_slug: r.channel_slug,
      text: `Your ${channelName(r.channel_slug)} test did not start: ${String(r.exec_result?.error ?? "it was refused").replace(/^cap_refuse:\s*/, "").slice(0, 300)}`,
    }));
    if (lines.length === 0) return [];
    const { data: notes } = await db.from("cgo_notes").select("items").eq("tenant_id", tenant_id).order("created_at", { ascending: false }).limit(5);
    const told = new Set(((notes ?? []) as Array<{ items: unknown }>).flatMap((n) => (Array.isArray(n.items) ? n.items : [])).map((i) => (i as { text?: unknown })?.text).filter((t): t is string => typeof t === "string"));
    return lines.filter((l) => !told.has(l.text));
  } catch {
    return [];
  }
}
