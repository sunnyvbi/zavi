
import { MIN_NEW_BUDGET_USD, type AdObject, type PlannedOrder, type ResultBasis } from "./ad-spend-controller";

export const RULE_STEP = 0.2;
export const CUT_MIN_AGE_DAYS = 7;
export const CUT_MIN_SPEND_DAYS = 5;
export const CUT_MIN_SETTLED_RESULTS = 20;
export const CUT_BAND = 2.0;
export const MIN_PEERS = 3;
export const CUT_DWELL_DAYS = 7;

export const cutDwellKeyOf = (platform: "meta" | "google", id: string) => `cut:${platform}:${id}`;

export function budgetHolder(o: AdObject): boolean {
  if (o.daily_budget_usd === null || o.daily_budget_usd <= 0) return false;
  return o.platform === "google" ? o.level === "campaign" : o.level === "campaign" || !o.budget_on_campaign;
}

export function cuttable(o: AdObject, protectedIds: ReadonlySet<string> = new Set()): boolean {
  if (o.brand === true || o.audience_ids.length > 0 || o.result_kind === "clicks" || protectedIds.has(o.id)) return false;
  return o.active && o.parent_active && budgetHolder(o);
}

const ageDays = (o: AdObject, now: Date) => (o.created_at ? (now.getTime() - Date.parse(o.created_at)) / 86_400_000 : Number.NaN);

export function seasonedForCut(o: AdObject, now: Date): boolean {
  const age = ageDays(o, now);
  return Number.isFinite(age) && age >= CUT_MIN_AGE_DAYS && o.spend_days7d >= CUT_MIN_SPEND_DAYS;
}

export function steadySpender(o: AdObject): boolean {
  return o.spend_days7d >= CUT_MIN_SPEND_DAYS;
}

export const settledCpr = (o: AdObject): number | null => (o.settled && o.settled.results > 0 ? o.settled.spend_usd / o.settled.results : null);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type CutCandidate = { o: AdObject; why: string; ratio: number;  median: number };

export function cutCandidates(a: {
  objects: readonly AdObject[];
  yardstick: readonly AdObject[];
  now: Date;
  basisOf: (o: AdObject) => ResultBasis;
  protectedIds: ReadonlySet<string>;
  skip: ReadonlySet<string>;
  savedLoser?: (o: AdObject) => string | null;
  peerOk?: (o: AdObject) => boolean;
  seasoned?: (o: AdObject, now: Date) => boolean;
}): CutCandidate[] {
  const out: CutCandidate[] = [];
  const key = (o: AdObject) => `${o.platform}:${a.basisOf(o)}`;
  for (const o of a.objects) {
    if (!cuttable(o, a.protectedIds) || !(a.seasoned ?? seasonedForCut)(o, a.now) || a.skip.has(cutDwellKeyOf(o.platform, o.id))) continue;
    const peers = a.yardstick
      .filter((p) => p.id !== o.id && key(p) === key(o) && (!a.peerOk || a.peerOk(p)))
      .map(settledCpr)
      .filter((c): c is number => c !== null);
    if (peers.length < MIN_PEERS) continue;
    const m = median(peers);
    const c = settledCpr(o);
    if (a.savedLoser) {
      const why = a.savedLoser(o);
      if (why) out.push({ o, why, ratio: c !== null && m > 0 ? c / m : 0, median: m });
      continue;
    }
    if (c === null || (o.settled?.results ?? 0) < CUT_MIN_SETTLED_RESULTS || m <= 0) continue;
    if (c > CUT_BAND * m) out.push({ o, why: `cost per result $${c.toFixed(2)} over its settled week is more than ${CUT_BAND}x the median of ${peers.length} comparable ads ($${m.toFixed(2)})`, ratio: c / m, median: m });
  }
  return out.sort((x, y) => y.ratio - x.ratio);
}

export function cutOrders(
  cands: readonly CutCandidate[],
  a: {
    step: number;
    stops: boolean;
    surplus: number;
    capacityAt: (o: AdObject, budget: number) => number;
    required_usd?: number;
    capacity_usd?: number;
  },
): { orders: PlannedOrder[]; tooSmall: CutCandidate[] } {
  let surplus = a.surplus;
  const orders: PlannedOrder[] = [];
  const tooSmall: CutCandidate[] = [];
  for (const c of cands) {
    const o = c.o;
    const from = o.daily_budget_usd as number;
    const name = o.name ?? (o.level === "campaign" ? "Campaign" : "Ad set");
    const channel_slug = o.platform === "meta" ? ("meta_ads" as const) : ("google_ads" as const);
    const dwell_key = cutDwellKeyOf(o.platform, o.id);
    const next = Math.ceil(Math.round(from * (1 - a.step) * 1e6) / 1e4) / 100;
    if (!a.stops && next < MIN_NEW_BUDGET_USD) {
      tooSmall.push(c);
      continue;
    }
    const drop = a.capacityAt(o, from) - a.capacityAt(o, a.stops ? 0 : next);
    if (drop > surplus + 0.005) continue;
    const required_usd = a.required_usd ?? 0;
    const capacity_usd = a.capacity_usd ?? 0;
    const numbers = { required_usd, capacity_usd, gap_usd: Math.max(0, Math.round((required_usd - capacity_usd) * 100) / 100), surplus_usd: Math.round(surplus * 100) / 100, cpr_usd: settledCpr(o), median_cpr_usd: c.median };
    const planner = a.stops ? { ...numbers, kind: "stop" as const } : { ...numbers, kind: "cut" as const, from_usd: from, step: a.step };
    surplus -= Math.max(0, drop);
    if (a.stops) {
      const reason = `${name}: ${c.why}, so it is paused (your saved automatic stops).`;
      orders.push({
        channel_slug,
        exec_class: `${channel_slug}.set_status`,
        body:
          o.platform === "meta"
            ? { object_id: o.id, level: o.level === "campaign" ? "campaign" : "adset", status: "PAUSED", rationale: reason.slice(0, 500), over_cap: false, name }
            : { campaign_id: o.id, level: "campaign", status: "PAUSED", rationale: reason.slice(0, 500), over_cap: false, name },
        reason,
        dwell_key,
        adds_usd: 0,
        planner,
      });
      continue;
    }
    const reason = `${name}: ${c.why}, so its daily budget goes from $${from.toFixed(2)} to $${next.toFixed(2)} (${Math.round(a.step * 100)}% at a time; what stays live still covers the month's pace).`;
    const metaSet = o.platform === "meta" && o.level === "ad_set";
    orders.push({
      channel_slug,
      exec_class: o.platform === "meta" ? `meta_ads.update_${metaSet ? "ad_set" : "campaign"}_budget` : "google_ads.update_campaign_budget",
      body: {
        [metaSet ? "ad_set_id" : "campaign_id"]: o.id,
        daily_budget_usd: next,
        expected_current_daily_budget_usd: from,
        rationale: reason.slice(0, 500),
        over_cap: false,
        ...(o.name ? { name: o.name } : {}),
      },
      reason,
      dwell_key,
      adds_usd: 0,
      planner,
    });
  }
  return { orders, tooSmall };
}
