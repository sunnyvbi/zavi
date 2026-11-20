import type { CutCandidate } from "./business-rules";
import { MAKE_ROOM_FLOOR_USD, makeRoomTo } from "./make-room-math";
import { MIN_MAKE_ROOM_CUT_USD } from "./pending-test-room-cuts";
import type { BudgetChoiceView } from "@/services/approvals/budget-choice";
import { fitDailyChange, type Fit, type MonthRead } from "@/services/decisions/ad-month-counter";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { FOUND_FOR_RAISE } from "./move-card";

export type FounderCutPick = { platform: "meta" | "google"; level: "ad_set" | "campaign"; object_id: string; name: string | null; from_usd: number; to_usd: number; frees_daily_usd: number; why: string };
export type NewCut = { platform: "meta" | "google"; object_id: string; to_usd: number };

const cents = (n: number) => Math.round(n * 100);
export const MAX_FOUNDER_CUTS = 4;

export function pickFounderCuts(cands: readonly CutCandidate[], needDaily: number, step: number, excludeObjectId: string): FounderCutPick[] {
  const out: FounderCutPick[] = [];
  for (const k of cands) {
    if (out.length >= MAX_FOUNDER_CUTS) break;
    const from = k.o.daily_budget_usd;
    if (k.o.id === excludeObjectId || from === null || !(from > 0)) continue;
    const to = makeRoomTo({ from_usd: from, hold_daily_usd: from, base_usd: 0, need_daily_usd: needDaily, step, floor_usd: MAKE_ROOM_FLOOR_USD });
    const frees = Math.round((from - to) * 100) / 100;
    if (frees < MIN_MAKE_ROOM_CUT_USD) continue;
    out.push({ platform: k.o.platform, level: k.o.level, object_id: k.o.id, name: k.o.name, from_usd: from, to_usd: to, frees_daily_usd: frees, why: k.why });
  }
  return out;
}

export function fitWithCounterCuts(m: Pick<MonthRead, "count" | "view" | "live_held_daily_usd">, deltaDaily: number, freedDaily: number): Fit {
  const count = freedDaily > 0 ? { ...m.count, projection_usd: (cents(m.count.projection_usd) - cents(freedDaily) * m.count.days_left) / 100 } : m.count;
  return fitDailyChange(count, m.view, m.live_held_daily_usd, deltaDaily);
}

export type FindMoney =
  | { kind: "candidates"; need_daily_usd: number; candidates: FounderCutPick[]; budget_choice: BudgetChoiceView | null }
  | { kind: "none"; why: "fits" | "no_budget" | "daily_limit_only" | "set_aside" | "spent" | "no_clearly_worse" | "not_enough" | "non_usd"; candidates: []; budget_choice: BudgetChoiceView | null }
  | { kind: "unreadable"; why: string; candidates: []; budget_choice: BudgetChoiceView | null };

export type FindMoneyDeps = {
  candidates?: (tenant_id: string) => Promise<{ cands: CutCandidate[]; step: number; incomplete?: boolean }>;
  currency?: (tenant_id: string, platform: "meta" | "google") => Promise<string>;
};

async function accountCurrency(tenant_id: string, platform: "meta" | "google"): Promise<string> {
  if (platform === "meta") return (await import("@/services/tools/meta-ads/_client")).getAdAccountCurrency(tenant_id);
  return (await import("@/services/tools/google-ads/write/_currency-guard")).readGoogleAccountCurrency(tenant_id);
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; r: FindMoney }>();
export const resetFindMoneyCache = (): void => cache.clear();

export async function findMoneyFor(tenant_id: string, raise: { id: string; decision_class: string; body: unknown }, opts: { cached?: boolean; deps?: FindMoneyDeps } = {}): Promise<FindMoney> {
  const k = `${tenant_id}:${raise.id}`;
  const hit = cache.get(k);
  if (opts.cached && hit && Date.now() - hit.at < CACHE_MS) return hit.r;
  const r = await findMoneyFresh(tenant_id, raise, opts.deps ?? {});
  if (cache.size > 500) cache.clear();
  cache.set(k, { at: Date.now(), r });
  return r;
}

async function findMoneyFresh(tenant_id: string, raise: { id: string; decision_class: string; body: unknown }, deps: FindMoneyDeps): Promise<FindMoney> {
  const { budgetChoiceView } = await import("@/services/approvals/budget-choice");
  const { readRaiseFit } = await import("@/services/decisions/ad-month-counter");
  const fit = await readRaiseFit(tenant_id, raise.decision_class, raise.body);
  if (fit.kind === "unreadable") return { kind: "unreadable", why: fit.why, candidates: [], budget_choice: { kind: "unreadable", why: fit.why } };
  if (fit.kind === "no_budget" || fit.kind === "not_a_raise") return { kind: "none", why: "no_budget", candidates: [], budget_choice: null };
  const view = budgetChoiceView(fit);
  if (fit.kind === "fits") return { kind: "none", why: "fits", candidates: [], budget_choice: view };
  if (fit.raise_to_usd === null) return { kind: "none", why: "daily_limit_only", candidates: [], budget_choice: view };
  if (cents(fit.gate_usd) > cents(fit.count.month_cap_usd)) {
    const holds = fit.view ? cents(fit.view.held_usd) + cents(fit.view.creator_held_usd) : 0;
    const why = holds > 0 && cents(fit.gate_usd) - holds <= cents(fit.count.month_cap_usd) ? "set_aside" : "spent";
    return { kind: "none", why, candidates: [], budget_choice: view };
  }
  const need = Math.ceil((fit.over_by_usd * 100) / Math.max(1, fit.count.days_left)) / 100;
  if (!(need > 0)) return { kind: "none", why: "daily_limit_only", candidates: [], budget_choice: view };
  let found: { cands: CutCandidate[]; step: number; incomplete?: boolean };
  try {
    found = await (deps.candidates ?? (async (t) => (await import("./ad-spend-controller")).founderCutCandidates(t)))(tenant_id);
  } catch (e) {
    console.warn(`[founder-cut-candidates] ads unreadable for ${tenant_id}: ${(e as Error).message}`);
    return { kind: "unreadable", why: "your ads could not be read", candidates: [], budget_choice: { kind: "unreadable", why: "your ads could not be read" } };
  }
  const usd = new Map<"meta" | "google", boolean>();
  for (const p of new Set(found.cands.map((c) => c.o.platform))) {
    let cur: string;
    try {
      cur = await (deps.currency ?? accountCurrency)(tenant_id, p);
    } catch (e) {
      console.warn(`[founder-cut-candidates] ${p} currency unreadable for ${tenant_id}: ${(e as Error).message}`);
      const why = `the ${p === "meta" ? "Meta" : "Google"} account's currency could not be read`;
      return { kind: "unreadable", why, candidates: [], budget_choice: { kind: "unreadable", why } };
    }
    usd.set(p, (cur ?? "").trim().toUpperCase() === "USD");
  }
  const usable = found.cands.filter((c) => usd.get(c.o.platform) === true);
  const picks = pickFounderCuts(usable, need, found.step, fit.raise?.object_id ?? "");
  const enough = picks.length > 0 && cents(picks.reduce((s, p) => s + p.frees_daily_usd, 0)) >= cents(need);
  if (!enough && found.incomplete) {
    const why = "one of your ad accounts could not be read";
    return { kind: "unreadable", why, candidates: [], budget_choice: { kind: "unreadable", why } };
  }
  if (found.cands.length && !usable.length) return { kind: "none", why: "non_usd", candidates: [], budget_choice: view };
  if (!picks.length) return { kind: "none", why: "no_clearly_worse", candidates: [], budget_choice: view };
  if (!enough) return { kind: "none", why: "not_enough", candidates: [], budget_choice: view };
  return { kind: "candidates", need_daily_usd: need, candidates: picks, budget_choice: view };
}

export type FindMoneyWhy = "set_aside" | "spent" | "not_enough" | "no_candidates" | "non_usd";
export type FindMoneyAvailability = { find_money: "available" | "unreadable"; find_money_why: null } | { find_money: "none"; find_money_why: FindMoneyWhy };

export function findMoneyWhyOf(why: string | null | undefined): FindMoneyWhy {
  return why === "set_aside" || why === "spent" || why === "not_enough" || why === "non_usd" ? why : "no_candidates";
}

export async function findMoneyAvailability(tenant_id: string, raise: { id: string; decision_class: string; body: unknown }, opts: { deps?: FindMoneyDeps } = {}): Promise<FindMoneyAvailability> {
  try {
    const r = await findMoneyFor(tenant_id, raise, { cached: true, ...opts });
    if (r.kind === "candidates") return { find_money: "available", find_money_why: null };
    if (r.kind === "unreadable") return { find_money: "unreadable", find_money_why: null };
    return { find_money: "none", find_money_why: findMoneyWhyOf(r.why) };
  } catch (e) {
    console.warn(`[founder-cut-candidates] availability unreadable for ${tenant_id}: ${(e as Error).message}`);
    return { find_money: "unreadable", find_money_why: null };
  }
}

export function picksMatch(picks: readonly NewCut[], fresh: readonly FounderCutPick[]): FounderCutPick[] | null {
  const out: FounderCutPick[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    const k = `${p.platform}:${p.object_id}`;
    if (seen.has(k)) return null;
    seen.add(k);
    const f = fresh.find((x) => x.platform === p.platform && x.object_id === p.object_id);
    if (!f || cents(f.to_usd) !== cents(p.to_usd)) return null;
    out.push(f);
  }
  return out;
}

export function cutClassOf(p: Pick<FounderCutPick, "platform" | "level">): string {
  return p.platform === "meta" ? `meta_ads.update_${p.level === "ad_set" ? "ad_set" : "campaign"}_budget` : "google_ads.update_campaign_budget";
}

export async function fileFounderCut(tenant_id: string, pick: FounderCutPick, group: string, raise_id: string): Promise<string> {
  const { REVIEW_SIBLING } = await import("./founder-order");
  const { serverFounderMarks } = await import("./founder-marks");
  const auto = cutClassOf(pick);
  const cls = REVIEW_SIBLING[auto];
  if (!cls) throw new Error(`no review class for ${auto}`);
  const base = {
    [pick.platform === "meta" && pick.level === "ad_set" ? "ad_set_id" : "campaign_id"]: pick.object_id,
    daily_budget_usd: pick.to_usd,
    expected_current_daily_budget_usd: pick.from_usd,
    rationale: `Cut you picked in Zavi to fund a raise: ${pick.why}.`.slice(0, 500),
    over_cap: false,
    ...(pick.name ? { name: pick.name } : {}),
    ...(pick.platform === "meta" ? { currency: "USD" } : {}),
  };
  let parsed: unknown;
  if (pick.platform === "google") parsed = (await import("@/services/tools/google-ads/write/_decision-bodies")).updateCampaignBudgetBodySchema.parse(base);
  else {
    const m = await import("@/services/tools/meta-ads/write/_decision-bodies");
    parsed = (pick.level === "ad_set" ? m.updateAdSetBudgetBodySchema : m.updateCampaignBudgetBodySchema).parse(base);
  }
  const body = { ...(serverFounderMarks(auto, parsed, { group, unverified: false }) as Record<string, unknown>), [FOUND_FOR_RAISE]: raise_id };
  const r = await tenantRpc(asTenantId(tenant_id), "emit_decision", { p_agent_run_id: null, p_decision_class: cls, p_body: body });
  if (r.error || typeof r.data !== "string") throw new Error(`not filed: ${r.error?.message ?? "no id"}`);
  if (!(await filedAsAsked(tenant_id, r.data, pick, group))) throw new Error("a different change to this ad is already open");
  return r.data;
}

async function filedAsAsked(tenant_id: string, id: string, pick: FounderCutPick, group: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("decisions").select("status, body").eq("tenant_id", tenant_id).eq("id", id).maybeSingle();
    if (error || !data) return false;
    const r = data as { status?: unknown; body?: Record<string, unknown> | null };
    const b = r.body ?? {};
    const key = pick.platform === "meta" && pick.level === "ad_set" ? "ad_set_id" : "campaign_id";
    return r.status === "proposed" && b[key] === pick.object_id && b.daily_budget_usd === pick.to_usd && b.move_group === group;
  } catch {
    return false;
  }
}
