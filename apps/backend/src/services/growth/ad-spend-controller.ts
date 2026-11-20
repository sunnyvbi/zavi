
import type { SpendPace } from "@/services/growth/spend-pace";
import type { AdGoalMode, AdGoalRead } from "./ad-goal-match";
import { CGO_MAX_RAISE_STEP } from "./cgo-spend-authority";
import { REJECTED_ORDER_DAYS } from "./cgo-brief";
import type { CgoAdOrderInput, CgoAdOrderResult } from "./cgo-ad-orders";
import type { Blocker } from "./cgo-blockers";
import { LAUNCH_GRACE_HOURS, OBSERVED_DAYS, dailyBudgetCapacityUsd } from "./delivery-capacity";
import { _resetAccountZones, dateInZone, knownAccountZone, metaAccountZone, rememberAccountZone, wholeDaysWindow } from "./account-zone";
import { launchAdCopySchema, normalizeLaunchCta, websiteAudienceName } from "@/services/tools/meta-ads/write/_decision-bodies";
import { PLATFORM_LINK_HOSTS } from "@/services/tools/meta-ads/_link-hosts";
import { isPartialRiskExecCode } from "@zavi/shared";
import { META_OBJECT_UNREACHABLE } from "@/services/channels/exec-failure";
import type { GeoLocations } from "@/services/tools/meta-ads/write/replace_ad_set_geo";
import { pickCopyRegion, type CopyRegion, type CopyTargets } from "./copy-regions";
import {
  DEFAULT_COOLDOWN_MINUTES,
  _resetMetaCooldowns,
  isMetaRateLimitCode,
  isSpendReducingMetaChange,
  metaCoolingUntil,
  metaProbeAvailable,
  startMetaCooldown,
  withMetaCaller,
} from "@/services/tools/meta-ads/_cooldown";

export const OVERBOOK = 1.2;
export const DWELL_HOURS = 24;
export const RAMP_HOURS = LAUNCH_GRACE_HOURS;
export const CPR_BAND = 1.5;
export const MAX_RAISE_STEP = CGO_MAX_RAISE_STEP;
export const UNDER_DELIVERY = 0.7;
export const MAX_DUPLICATES = 3;
const MAKE_ROOM_TEST_KEY = "make_room_test_id";
const MAKE_ROOM_FREES_KEY = "make_room_frees_usd";
export const MIN_NEW_BUDGET_USD = 5;
export const SETTLE_DAYS = 3;
export const RETARGET_SHARE = 0.125;
export const MIN_RETARGET_AUDIENCE = 1000;
export const VARIANTS_LOW = 3;
export const VARIANTS_HIGH = 5;
export const MAX_CREATIVES_PER_RUN = 3;

export type ResultKind = "conversions" | "clicks";

export type AdObject = {
  platform: "meta" | "google";
  level: "ad_set" | "campaign";
  id: string;
  campaign_id: string | null;
  name: string | null;
  active: boolean;
  paused_self: boolean;
  parent_active: boolean;
  daily_budget_usd: number | null;
  budget_on_campaign: boolean;
  spend7d_usd: number;
  spend3d_usd: number;
  spend_days7d: number;
  results7d: number;
  result_kind: ResultKind;
  results_are_bookings?: boolean;
  results_are_value?: boolean;
  purchases7d?: number;
  purchase_value7d_usd?: number;
  settled?: { spend_usd: number; results: number; purchases: number; purchase_value_usd: number };
  brand?: boolean;
  channel_type?: string;
  has_live_ads: boolean | null;
  has_any_ads: boolean | null;
  has_ready_ads: boolean | null;
  audience_ids: string[];
  goal?: string | null;
  geo?: GeoLocations | null;
  created_at: string | null;
  not_serving?: string;
};

export type MetaAd = { id: string; ad_set_id: string; campaign_id: string | null; live: boolean; created_at: string | null };

export type Unread = { reason: string; rate_limited: boolean; ledger_capacity_usd: number | null };

export type Inventory = {
  reddit?: { connected: boolean; capacity_usd: number | null };
  x?: { connected: boolean; capacity_usd: number | null };
  tiktok?: { connected: boolean; capacity_usd: number | null };
  meta: { connected: boolean; objects: AdObject[]; ads: MetaAd[]; unread?: Unread };
  google: {
    connected: boolean;
    objects: AdObject[];
     conversions30d: number | null;
    unread?: Unread;
    purchases_unread?: boolean;
    brand_unread?: boolean;
    brand_unread_why?: string;
  };
};

export function applyGoalBasis(inv: Inventory, mode: AdGoalMode): Inventory {
  if (mode === "native") return inv;
  const apply = (objects: AdObject[], platform: "meta" | "google"): AdObject[] => {
    const leaves = objects.filter((o) => !(platform === "meta" && o.level === "campaign"));
    const anyPurchase = leaves.some((o) => (o.purchases7d ?? 0) > 0);
    if (!anyPurchase) return objects;
    const byValue = mode === "value" && leaves.some((o) => (o.purchase_value7d_usd ?? 0) > 0);
    return objects.map((o) => {
      if (platform === "meta" && o.result_kind === "clicks" && !(o.level === "campaign" && (o.purchases7d ?? 0) > 0)) return o;
      return {
        ...o,
        result_kind: "conversions" as ResultKind,
        results7d: round2(byValue ? o.purchase_value7d_usd ?? 0 : o.purchases7d ?? 0),
        ...(o.settled ? { settled: { ...o.settled, results: round2(byValue ? o.settled.purchase_value_usd : o.settled.purchases) } } : {}),
        results_are_bookings: true,
        ...(byValue ? { results_are_value: true } : {}),
      };
    });
  };
  return {
    ...inv,
    meta: { ...inv.meta, objects: apply(inv.meta.objects, "meta") },
    google: { ...inv.google, objects: apply(inv.google.objects, "google") },
  };
}

export function unreadPlatforms(inv: Inventory): Array<"meta" | "google"> {
  return [...(inv.meta.unread ? (["meta"] as const) : []), ...(inv.google.unread ? (["google"] as const) : [])];
}

export function liveCapacityUsd(inv: Inventory, now: Date, recentlyOrdered: ReadonlySet<string>): number {
  const read = [...inv.meta.objects, ...inv.google.objects].reduce((s, o) => s + objectCapacityUsd(o, now, recentlyOrdered), 0);
  const stored = (inv.meta.unread?.ledger_capacity_usd ?? 0) + (inv.google.unread?.ledger_capacity_usd ?? 0);
  return round2(read + stored + (inv.reddit?.capacity_usd ?? 0) + (inv.x?.capacity_usd ?? 0) + (inv.tiktok?.capacity_usd ?? 0));
}

export type PlannedOrder = {
  channel_slug: "meta_ads" | "google_ads";
  exec_class: string;
  body: Record<string, unknown>;
  reason: string;
  dwell_key: string;
  adds_usd: number;
  planner?: import("./cgo-ad-orders").PlannerNumbers;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${round2(n).toFixed(2)}`;

export function dwellKeyOf(platform: "meta" | "google", id: string): string {
  return `obj:${platform}:${id}`;
}

export function orderKindOf(exec_class: string, body: Record<string, unknown> | null | undefined): { kind: string; cut: boolean } {
  const cls = exec_class.replace(/_review$/, "");
  const b = body ?? {};
  let dir: "up" | "down" | null = null;
  if (cls.endsWith(".set_status")) dir = b.status === "ACTIVE" || b.status === "ENABLED" ? "up" : "down";
  else if (cls.endsWith("_budget")) dir = Number(b.daily_budget_usd) < Number(b.expected_current_daily_budget_usd) ? "down" : "up";
  else if (cls === "google_ads.remove_resource") dir = "down";
  return { kind: dir ? `${cls}:${dir}` : cls, cut: dir === "down" };
}

export function rejectHoldKey(dwell_key: string, exec_class: string, body: Record<string, unknown> | null | undefined): string {
  return `${dwell_key}|${orderKindOf(exec_class, body).kind}`;
}

export function requiredDailyUsd(pace: Pick<SpendPace, "daily_target_usd" | "delivery_debt_usd" | "days_left">): number {
  const days = Math.max(1, pace.days_left);
  return round2(Math.max(0, pace.daily_target_usd) * OVERBOOK + Math.max(0, pace.delivery_debt_usd) / days);
}

function hoursSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 3_600_000 : null;
}

function dailyRate(o: AdObject): number {
  return o.spend7d_usd / Math.max(1, o.spend_days7d);
}

export function metaCannotDeliver(o: Pick<AdObject, "platform" | "level" | "has_any_ads" | "has_live_ads">): boolean {
  return o.platform === "meta" && o.level === "ad_set" && o.has_any_ads === true && o.has_live_ads === false;
}

export function cannotDeliverAdSets(objects: readonly AdObject[]): AdObject[] {
  return objects.filter(
    (o) =>
      o.level === "ad_set" &&
      o.active &&
      o.parent_active &&
      (o.budget_on_campaign || (o.daily_budget_usd !== null && o.daily_budget_usd > 0)) &&
      metaCannotDeliver(o),
  );
}

export function cannotDeliverBlocker(o: AdObject, now: Date): Blocker {
  const name = o.name ? `"${o.name}"` : o.id;
  return {
    id: `meta-no-live-ad:${o.id}`,
    kind: "ad_delivery",
    what: `Fix the ads in Meta ad set ${name}: none of them can run (rejected, needs an update, or switched off), so it can't spend`,
    who: "you",
    since: now.toISOString(),
    usd_at_stake: null,
    at_risk_now: false,
    notify_now: true,
    meanwhile: "it spends nothing until an ad can run, and Autopilot will not raise it meanwhile",
    channel_slug: "meta_ads",
  };
}

export function objectCapacityUsd(o: AdObject, now: Date, recentlyOrdered: ReadonlySet<string>): number {
  if (!o.active || !o.parent_active || o.daily_budget_usd === null || o.daily_budget_usd <= 0) return 0;
  const age = hoursSince(o.created_at, now);
  const just_launched = recentlyOrdered.has(dwellKeyOf(o.platform, o.id)) || (age !== null && age < RAMP_HOURS);
  return dailyBudgetCapacityUsd(o.daily_budget_usd, { just_launched, spend_observed_usd: o.spend3d_usd });
}

const cpr = (o: AdObject) => (o.results7d > 0 ? o.spend7d_usd / o.results7d : null);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type ResultBasis = "value" | "bookings" | ResultKind;
export const resultBasis = (o: AdObject): ResultBasis => (o.results_are_bookings ? (o.results_are_value ? "value" : "bookings") : o.result_kind);
const BASIS_ORDER: Readonly<Record<ResultBasis, number>> = { value: 0, bookings: 1, conversions: 2, clicks: 3 };
const goalHit = (o: AdObject) => o.results_are_bookings === true && o.results7d > 0;

function inBand(o: AdObject, medians: Map<string, number | null>, keyOf: (o: AdObject) => string = resultBasis): boolean {
  const m = medians.get(keyOf(o)) ?? null;
  if (m === null) return true;
  const c = cpr(o);
  if (c === null) return o.spend7d_usd <= CPR_BAND * m;
  return c <= CPR_BAND * m;
}

function rank(a: AdObject, b: AdObject): number {
  if (goalHit(a) !== goalHit(b)) return goalHit(a) ? -1 : 1;
  const ca = cpr(a);
  const cb = cpr(b);
  if ((ca === null) !== (cb === null)) return ca === null ? 1 : -1;
  const basis = BASIS_ORDER[resultBasis(a)] - BASIS_ORDER[resultBasis(b)];
  if (basis !== 0) return basis;
  if (ca !== null && cb !== null) return ca - cb || b.spend7d_usd - a.spend7d_usd;
  return b.spend7d_usd - a.spend7d_usd;
}

const isRetargeting = (o: AdObject) => o.audience_ids.length > 0;

export type GapPlan = {
  required_usd: number;
  capacity_usd: number;
  gap_usd: number;
  orders: PlannedOrder[];
  remaining_usd: number;
  wake_cgo: boolean;
  blind: boolean;
  notes: string[];
};

export type GapPlanInput = {
  pace: SpendPace;
  inv: Inventory;
  now: Date;
  dwell: ReadonlySet<string>;
  recentlyOrdered: ReadonlySet<string>;
  enableSafe: ReadonlySet<string>;
  held?: ReadonlySet<string>;
  copies?: ReadonlySet<string>;
  rejected?: ReadonlySet<string>;
  rules?: {
    step: number;
    perPlatform: boolean;
    canRaise?: (o: AdObject) => boolean;
  };
  copyRegions?: readonly CopyRegion[];
  frozen?: ReadonlySet<"meta" | "google">;
  frozenWhy?: Partial<Record<"meta" | "google", string>>;
};

export function planGapOrders(i: GapPlanInput): GapPlan {
  const { pace, inv, now, dwell } = i;
  const held = i.held ?? new Set<string>();
  const notHeld = (o: AdObject) => !held.has(dwellKeyOf(o.platform, o.id));
  const rejected = (o: PlannedOrder) => !!i.rejected?.has(rejectHoldKey(o.dwell_key, o.exec_class, o.body));
  const notes: string[] = [];
  const required = requiredDailyUsd(pace);
  const capacity = liveCapacityUsd(inv, now, i.recentlyOrdered);
  const gap = round2(Math.max(0, required - capacity));
  const orders: PlannedOrder[] = [];
  let remaining = gap;
  if (!pace.data_fresh) notes.push("spend data is stale: planning increases only");
  const unread = unreadPlatforms(inv);
  const frozen = i.frozen ?? new Set<"meta" | "google">();
  const blind = unread.length > 0 || frozen.size > 0;
  for (const p of frozen) notes.push(`${p} not changed this hour (${i.frozenWhy?.[p] ?? "rate limit"}): the gap goes elsewhere`);
  for (const p of unread) {
    const u = inv[p].unread as Unread;
    notes.push(
      u.ledger_capacity_usd === null
        ? `${p} unreadable and no fresh stored read: its live budget is unknown`
        : `${p} unreadable: its live budget is taken as the ${usd(u.ledger_capacity_usd)}/day the last stored read shows; nothing is changed on it`,
    );
  }
  if (unread.some((p) => inv[p].unread?.ledger_capacity_usd === null)) {
    notes.push("gap unknown: no budget changes this hour");
    return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: gap, wake_cgo: false, blind, notes };
  }
  if (inv.tiktok?.connected && inv.tiktok.capacity_usd === null) return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: gap, wake_cgo: false, blind: true, notes: [...notes, "TikTok Ads spend capacity could not be read; shared budget growth is held."] };
  if (inv.x?.connected && inv.x.capacity_usd === null) return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: gap, wake_cgo: false, blind: true, notes: [...notes, "X Ads spend capacity could not be read; shared budget growth is held."] };
  if (inv.reddit?.connected && inv.reddit.capacity_usd === null) return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: gap, wake_cgo: false, blind: true, notes: [...notes, "Reddit spend capacity could not be read; shared budget growth is held."] };
  if (remaining < 1) return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: round2(remaining), wake_cgo: false, blind, notes };

  const all = [...inv.meta.objects, ...inv.google.objects];
  const delivering = all.filter((o) => o.active && o.parent_active && o.spend7d_usd > 0 && !isRetargeting(o) && !o.brand);
  const growable = (o: AdObject) => !frozen.has(o.platform) && !o.brand;
  const keyOf = i.rules?.perPlatform ? (o: AdObject) => `${o.platform}:${resultBasis(o)}` : (o: AdObject) => resultBasis(o);
  const yard = i.rules?.perPlatform
    ? delivering.filter((o) => o.daily_budget_usd !== null && o.daily_budget_usd > 0 && (o.platform === "google" ? o.level === "campaign" : o.level === "campaign" || !o.budget_on_campaign))
    : delivering;
  const medians = new Map<string, number | null>();
  for (const k of new Set(yard.map(keyOf))) {
    medians.set(k, median(yard.filter((o) => keyOf(o) === k).map(cpr).filter((c): c is number => c !== null)));
  }
  const banded = (o: AdObject) => inBand(o, medians, keyOf);
  const metaCanGrow = inv.meta.connected && !frozen.has("meta") && inv.meta.objects.some((o) => o.active && o.parent_active);
  const googleCold = inv.google.conversions30d === 0 && metaCanGrow;
  if (googleCold) notes.push("Google has no conversions in 30 days: the gap goes to Meta");

  const raisable = delivering
    .filter(growable)
    .filter((o) => o.daily_budget_usd !== null && o.daily_budget_usd > 0)
    .filter((o) => (o.platform === "meta" ? (o.level === "ad_set" ? !o.budget_on_campaign : true) : o.level === "campaign"))
    .filter((o) => !(o.platform === "google" && googleCold))
    .filter((o) => dailyRate(o) >= UNDER_DELIVERY * (o.daily_budget_usd as number))
    .filter((o) => !metaCannotDeliver(o))
    .filter((o) => !dwell.has(dwellKeyOf(o.platform, o.id)))
    .filter(notHeld)
    .filter(banded)
    .filter((o) => !i.rules?.canRaise || i.rules.canRaise(o))
    .sort(rank);
  const raiseStep = i.rules ? i.rules.step : MAX_RAISE_STEP;
  for (const o of raisable) {
    if (remaining < 1) break;
    const b = o.daily_budget_usd as number;
    const add = round2(Math.min(b * raiseStep, remaining));
    if (add < 1) continue;
    const next = round2(b + add);
    const reason = `Autopilot budget is behind pace: ${usd(required)}/day is needed live and ${usd(capacity)}/day is. This one delivers its whole budget at a good cost per result, so its budget goes from ${usd(b)} to ${usd(next)} a day.`;
    const planner = { kind: "raise" as const, required_usd: required, capacity_usd: capacity, gap_usd: gap, room_usd: remaining, from_usd: b, step: raiseStep, cpr_usd: cpr(o), median_cpr_usd: medians.get(keyOf(o)) ?? null };
    const order: PlannedOrder =
      o.platform === "meta"
        ? {
            channel_slug: "meta_ads",
            exec_class: o.level === "campaign" ? "meta_ads.update_campaign_budget" : "meta_ads.update_ad_set_budget",
            body: { [o.level === "campaign" ? "campaign_id" : "ad_set_id"]: o.id, daily_budget_usd: next, expected_current_daily_budget_usd: b, rationale: reason.slice(0, 500), over_cap: false, ...(o.name ? { name: o.name } : {}) },
            reason,
            dwell_key: dwellKeyOf("meta", o.id),
            adds_usd: add,
            planner,
          }
        : {
            channel_slug: "google_ads",
            exec_class: "google_ads.update_campaign_budget",
            body: { campaign_id: o.id, daily_budget_usd: next, expected_current_daily_budget_usd: b, rationale: reason.slice(0, 500), over_cap: false, ...(o.name ? { name: o.name } : {}) },
            reason,
            dwell_key: dwellKeyOf("google", o.id),
            adds_usd: add,
            planner,
          };
    if (rejected(order)) continue;
    orders.push(order);
    remaining = round2(remaining - add);
  }

  if (remaining >= 1) {
    const ready = all
      .filter(growable)
      .filter((o) => o.paused_self && o.parent_active && o.daily_budget_usd !== null && o.daily_budget_usd > 0)
      .filter((o) => !(o.platform === "google" && googleCold))
      .filter((o) => o.platform === "google" || o.has_ready_ads === true)
      .filter((o) => !isRetargeting(o))
      .filter((o) => i.enableSafe.has(dwellKeyOf(o.platform, o.id)))
      .filter((o) => !dwell.has(dwellKeyOf(o.platform, o.id)))
      .filter(notHeld)
      .sort(rank);
    for (const o of ready) {
      if (remaining < 1) break;
      const b = o.daily_budget_usd as number;
      const reason = `Autopilot budget is behind pace by ${usd(remaining)}/day. Zavi set this up and it is ready, so it is switched on at its ${usd(b)} daily budget.`;
      const planner = { kind: "switch_on" as const, required_usd: required, capacity_usd: capacity, gap_usd: gap, room_usd: remaining, from_usd: b };
      const order: PlannedOrder =
        o.platform === "meta"
          ? {
              channel_slug: "meta_ads",
              exec_class: "meta_ads.set_status",
              body: { object_id: o.id, level: o.level === "campaign" ? "campaign" : "adset", status: "ACTIVE", rationale: reason.slice(0, 500), over_cap: false, ...(o.name ? { name: o.name } : {}) },
              reason,
              dwell_key: dwellKeyOf("meta", o.id),
              adds_usd: b,
              planner,
            }
          : {
              channel_slug: "google_ads",
              exec_class: "google_ads.set_status",
              body: { campaign_id: o.id, level: "campaign", status: "ENABLED", rationale: reason.slice(0, 500), over_cap: false, ...(o.name ? { name: o.name } : {}) },
              reason,
              dwell_key: dwellKeyOf("google", o.id),
              adds_usd: b,
              planner,
            };
      if (rejected(order)) continue;
      orders.push(order);
      remaining = round2(remaining - b);
    }
  }

  if (remaining >= 1 && !frozen.has("meta")) {
    const regions = i.copyRegions ?? [];
    const campaigns = new Map(inv.meta.objects.filter((o) => o.level === "campaign").map((o) => [o.id, o]));
    const picks: Array<{ src: AdObject; region: CopyRegion }> = [];
    const seen = new Set<string>();
    const taken = new Set<string>();
    for (const o of delivering.filter((x) => x.platform === "meta" && x.level === "ad_set" && x.has_live_ads === true && notHeld(x) && banded(x)).sort(rank)) {
      if (regions.length === 0) break;
      const src = o.budget_on_campaign && o.campaign_id ? campaigns.get(o.campaign_id) : o;
      if (!src || seen.has(src.id)) continue;
      if (src.level === "campaign" && !src.active) continue;
      if (!notHeld(src)) continue;
      if (i.copies?.has(src.id) || i.copies?.has(o.id)) continue;
      if (src.daily_budget_usd === null || src.daily_budget_usd <= 0) continue;
      if (dwell.has(`dup:${src.id}`)) continue;
      if (src.level === "campaign") {
        const goals = new Set(inv.meta.objects.filter((x) => x.level === "ad_set" && x.campaign_id === src.id && !x.paused_self).map((x) => x.goal ?? null));
        if (goals.size !== 1 || !goals.has(o.goal ?? null)) continue;
      }
      const region = pickCopyRegion(o.goal, regions, taken);
      if (!region) continue;
      seen.add(src.id);
      taken.add(`${o.goal}|${region.meta.type}:${region.meta.key}`);
      picks.push({ src, region });
      if (picks.length >= MAX_DUPLICATES) break;
    }
    if (picks.length === 0) notes.push(regions.length === 0 ? "no order region to copy into: nothing copied" : "every order region already has ads after the same result: nothing copied");
    for (let k = 0; k < picks.length && remaining >= 1; k++) {
      const { src, region } = picks[k]!;
      const share = k === picks.length - 1 ? remaining : remaining / (picks.length - k);
      const budget = round2(Math.min(src.daily_budget_usd as number, Math.max(MIN_NEW_BUDGET_USD, share)));
      const reason = `Autopilot budget is behind pace by ${usd(remaining)}/day. ${region.label} has orders and no ad after the same result, so this one is copied there with its ads at ${usd(budget)} a day.`;
      const isCampaign = src.level === "campaign";
      const name = src.name ? { name: `${src.name} (copy, ${region.label})`.slice(0, 200) } : {};
      const places = [region.meta];
      const order: PlannedOrder = {
        channel_slug: "meta_ads",
        exec_class: isCampaign ? "meta_ads.duplicate_campaign" : "meta_ads.duplicate_ad_set",
        body: isCampaign ? { source_campaign_id: src.id, daily_budget_usd: budget, places, ...name } : { source_ad_set_id: src.id, daily_budget_usd: budget, places, ...name },
        reason,
        dwell_key: `dup:${src.id}`,
        adds_usd: budget,
        planner: { kind: "copy", required_usd: required, capacity_usd: capacity, gap_usd: gap, room_usd: remaining, share_usd: share, cap_usd: src.daily_budget_usd as number, floor_usd: MIN_NEW_BUDGET_USD },
      };
      if (rejected(order)) continue;
      orders.push(order);
      remaining = round2(remaining - budget);
    }
  }

  remaining = round2(Math.max(0, remaining));
  const wake_cgo = !blind && remaining >= Math.max(5, 0.05 * required);
  if (wake_cgo) notes.push(`${usd(remaining)}/day of the gap has nowhere efficient to go: waking the CGO with it`);
  return { required_usd: required, capacity_usd: capacity, gap_usd: gap, orders, remaining_usd: remaining, wake_cgo, blind, notes };
}

export type WebsiteAudience = { id: string; count: number | null };

export type CreativeCopy = { source_ad_id: string; primary_text: string; headline: string; link_url: string; cta?: string };

export function normalizeAdLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname.includes(".") || PLATFORM_LINK_HOSTS.test(u.hostname)) return null;
  return u.toString();
}

export function normalizeCreativeCopy(c: CreativeCopy | null | undefined): CreativeCopy | null {
  if (!c) return null;
  const link_url = normalizeAdLinkUrl(c.link_url);
  const primary_text = (c.primary_text ?? "").trim();
  const headline = (c.headline ?? "").trim();
  if (!link_url || !primary_text || !headline || primary_text.length > 2000 || headline.length > 255) return null;
  const cta = normalizeLaunchCta(c.cta);
  return { source_ad_id: c.source_ad_id, primary_text, headline, link_url, ...(cta ? { cta } : {}) };
}

export type AdSetSetup = {
  campaign_id: string;
  optimization_goal: string;
  billing_event: string;
  promoted_object?: Record<string, unknown> | null;
  geo_locations: Record<string, unknown> | null;
};

export type RetargetDeps = {
  readWebsiteAudience: () => Promise<WebsiteAudience | null>;
  readAdSetSetup: (ad_set_id: string) => Promise<AdSetSetup | null>;
  readCreativeCopy: (ad_set_id: string) => Promise<CreativeCopy | null>;
};

export function metaShare(inv: Inventory, now: Date, recentlyOrdered: ReadonlySet<string>): number {
  if (!inv.meta.connected) return 0;
  const meta = inv.meta.objects.reduce((s, o) => s + objectCapacityUsd(o, now, recentlyOrdered), 0) + (inv.meta.unread?.ledger_capacity_usd ?? 0);
  const google = inv.google.objects.reduce((s, o) => s + objectCapacityUsd(o, now, recentlyOrdered), 0) + (inv.google.unread?.ledger_capacity_usd ?? 0);
  return meta + google > 0 ? meta / (meta + google) : inv.google.connected && (inv.google.unread || inv.google.objects.some((o) => o.active)) ? 0.5 : 1;
}

function bestProspecting(inv: Inventory): AdObject | null {
  return prospectingTemplates(inv)[0] ?? null;
}

export async function planRetargeting(
  i: {
    pace: SpendPace;
    inv: Inventory;
    now: Date;
    dwell: ReadonlySet<string>;
    recentlyOrdered: ReadonlySet<string>;
    enableSafe: ReadonlySet<string>;
    adReadiness?: () => Promise<{ ok: true } | { ok: false; code: string }>;
  },
  deps: RetargetDeps,
): Promise<{ order: PlannedOrder | null; note: string }> {
  const { inv, dwell } = i;
  if (!inv.meta.connected) return { order: null, note: "meta not connected" };
  if (inv.meta.unread) return { order: null, note: "meta unreadable: retargeting waits" };
  const target = round2(Math.max(MIN_NEW_BUDGET_USD, i.pace.daily_target_usd * metaShare(inv, i.now, i.recentlyOrdered) * RETARGET_SHARE));
  const required = requiredDailyUsd(i.pace);
  const capacity = liveCapacityUsd(inv, i.now, i.recentlyOrdered);
  const base = { required_usd: required, capacity_usd: capacity, gap_usd: round2(Math.max(0, required - capacity)), cap_usd: target };
  const audience = await deps.readWebsiteAudience();
  if (!audience) {
    if (dwell.has("aud:website")) return { order: null, note: "website audience requested, waiting" };
    return {
      order: {
        channel_slug: "meta_ads",
        exec_class: "meta_ads.create_custom_audience",
        body: { kind: "website_visitors", retention_days: 30, name: websiteAudienceName(30) },
        reason: "An always-on retargeting ad set needs the people who visited the website in the last 30 days, so Zavi builds that audience from the pixel.",
        dwell_key: "aud:website",
        adds_usd: 0,
      },
      note: "creating the website audience",
    };
  }
  if (audience.count === null || audience.count < MIN_RETARGET_AUDIENCE) return { order: null, note: "website audience under 1K people: retargeting money stays in prospecting" };

  const rt = inv.meta.objects.filter((o) => o.level === "ad_set" && o.audience_ids.includes(audience.id));
  const live = rt.find((o) => o.active && o.parent_active);
  if (live) {
    if (metaCannotDeliver(live)) return { order: null, note: "retargeting has no ad that can run: its budget is not raised" };
    const b = live.daily_budget_usd;
    if (b === null || live.budget_on_campaign || b >= 0.8 * target || dwell.has(dwellKeyOf("meta", live.id))) return { order: null, note: "retargeting live" };
    const next = round2(Math.min(target, b * (1 + MAX_RAISE_STEP)));
    const reason = `Retargeting keeps about ${Math.round(RETARGET_SHARE * 100)}% of the daily ad target, so its budget goes from ${usd(b)} to ${usd(next)} a day.`;
    return {
      order: {
        channel_slug: "meta_ads",
        exec_class: "meta_ads.update_ad_set_budget",
        body: { ad_set_id: live.id, daily_budget_usd: next, expected_current_daily_budget_usd: b, rationale: reason, over_cap: false, ...(live.name ? { name: live.name } : {}) },
        reason,
        dwell_key: dwellKeyOf("meta", live.id),
        adds_usd: round2(next - b),
        planner: { ...base, kind: "retarget_raise", from_usd: b, step: MAX_RAISE_STEP },
      },
      note: "raising retargeting to its share",
    };
  }
  const paused = rt.find((o) => o.paused_self && o.parent_active && !dwell.has(dwellKeyOf("meta", o.id)));
  if (paused) {
    if (paused.has_ready_ads !== true) {
      if (dwell.has(`creative:${paused.id}`)) return { order: null, note: "retargeting ad requested, waiting" };
      if (i.adReadiness) {
        const r = await i.adReadiness();
        if (!r.ok) return { order: null, note: `retargeting ad held: Meta cannot take a new ad yet (${r.code})` };
      }
      const src = bestProspecting(inv);
      const copy = src ? normalizeCreativeCopy(await deps.readCreativeCopy(src.id)) : null;
      if (!copy) return { order: null, note: "no ad with words and a website link to copy into retargeting" };
      return {
        order: {
          channel_slug: "meta_ads",
          exec_class: "meta_ads.create_ad",
          body: { ad_set_id: paused.id, primary_text: copy.primary_text, headline: copy.headline, link_url: copy.link_url, ...(copy.cta ? { cta: copy.cta } : {}), source: "copy", source_ad_id: copy.source_ad_id },
          reason: "The retargeting ad set needs an ad: it reuses the best live ad's words and picture.",
          dwell_key: `creative:${paused.id}`,
          adds_usd: 0,
        },
        note: "adding an ad to retargeting",
      };
    }
    if (!i.enableSafe.has(dwellKeyOf("meta", paused.id))) return { order: null, note: "retargeting ad set paused by someone else: left alone" };
    const b = paused.daily_budget_usd ?? target;
    const reason = `The retargeting ad set Zavi built is ready, so it is switched on at ${usd(b)} a day.`;
    return {
      order: {
        channel_slug: "meta_ads",
        exec_class: "meta_ads.set_status",
        body: { object_id: paused.id, level: "adset", status: "ACTIVE", rationale: reason, over_cap: false, ...(paused.name ? { name: paused.name } : {}) },
        reason,
        dwell_key: dwellKeyOf("meta", paused.id),
        adds_usd: b,
      },
      note: "switching retargeting on",
    };
  }
  if (rt.length > 0) return { order: null, note: "retargeting ad set exists and is off: left alone" };
  if (dwell.has("rt:create")) return { order: null, note: "retargeting ad set requested, waiting" };
  const src = bestProspecting(inv);
  const setup = src ? await deps.readAdSetSetup(src.id) : null;
  if (!src || !setup) return { order: null, note: "no live ad set to build retargeting from" };
  const reason = `People who visited the website in the last 30 days are the cheapest to win back, so Zavi keeps one retargeting ad set at about ${Math.round(RETARGET_SHARE * 100)}% of the daily ad target (${usd(target)} a day).`;
  return {
    order: {
      channel_slug: "meta_ads",
      exec_class: "meta_ads.create_ad_set",
      body: {
        campaign_id: setup.campaign_id,
        name: "Retargeting: website visitors 30 days",
        daily_budget_usd: target,
        optimization_goal: setup.optimization_goal,
        billing_event: setup.billing_event,
        targeting: { ...(setup.geo_locations ? { geo_locations: setup.geo_locations } : {}), custom_audiences: [{ id: audience.id }] },
        ...(setup.promoted_object ? { promoted_object: setup.promoted_object } : {}),
        rationale: reason.slice(0, 500),
      },
      reason,
      dwell_key: "rt:create",
      adds_usd: 0,
      planner: { ...base, kind: "retarget_create" },
    },
    note: "creating the retargeting ad set",
  };
}

export type CreativeDeps = {
  fatiguedAdSets: (ad_set_ids: string[]) => Promise<ReadonlySet<string>>;
  readCreativeCopy: (ad_set_id: string) => Promise<CreativeCopy | null>;
  generateImage: (copy: CreativeCopy) => Promise<string | null>;
  openConflict?: (ad_set_id: string) => Promise<boolean>;
  adReadiness?: () => Promise<{ ok: true } | { ok: false; code: string }>;
};

function prospectingTemplates(inv: Inventory): AdObject[] {
  return inv.meta.objects
    .filter((o) => o.level === "ad_set" && o.active && o.parent_active && !o.budget_on_campaign && !isRetargeting(o) && o.has_live_ads === true && o.spend7d_usd > 0)
    .sort(rank);
}

async function firstReadableCopy(deps: Pick<CreativeDeps, "readCreativeCopy">, ad_set_ids: string[]): Promise<CreativeCopy | null> {
  for (const id of ad_set_ids.slice(0, 5)) {
    const c = normalizeCreativeCopy(await deps.readCreativeCopy(id));
    if (c) return c;
  }
  return null;
}

async function creativeOrderBody(
  deps: Pick<CreativeDeps, "generateImage">,
  ad_set_id: string,
  copy: CreativeCopy,
  reuseSourcePicture: boolean,
  notes: string[],
): Promise<Record<string, unknown> | null> {
  const words = { primary_text: copy.primary_text, headline: copy.headline, link_url: copy.link_url, ...(copy.cta ? { cta: copy.cta } : {}) };
  const refused = (what: Record<string, unknown>) => {
    const r = launchAdCopySchema.safeParse(what);
    return r.success ? null : r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 160);
  };
  const wordsRefused = refused(words);
  if (wordsRefused) {
    notes.push(`ad for ${ad_set_id} not filed: ${wordsRefused}`);
    return null;
  }
  const image_url = await deps.generateImage(copy);
  let body: Record<string, unknown>;
  if (image_url) {
    body = { ad_set_id, image_url, ...words, source: "zavi_generated" };
  } else if (reuseSourcePicture) {
    notes.push(`no image made for ${ad_set_id}: it reuses the picture of ad ${copy.source_ad_id}`);
    body = { ad_set_id, ...words, source: "copy", source_ad_id: copy.source_ad_id };
  } else {
    notes.push(`no image made for ${ad_set_id}: no new variant this hour`);
    return null;
  }
  const imageRefused = image_url ? refused({ ...words, image_url }) : null;
  if (imageRefused) {
    notes.push(`ad for ${ad_set_id} not filed: ${imageRefused}`);
    return null;
  }
  return body;
}

export async function planCreatives(
  i: { inv: Inventory; now: Date; dwell: ReadonlySet<string>; enableSafe?: ReadonlySet<string>; held?: ReadonlySet<string> },
  deps: CreativeDeps,
): Promise<{ orders: PlannedOrder[]; notes: string[] }> {
  const { inv, now, dwell } = i;
  const orders: PlannedOrder[] = [];
  const notes: string[] = [];
  if (!inv.meta.connected || inv.meta.unread) return { orders, notes };
  let readiness: Promise<{ ok: true } | { ok: false; code: string }> | undefined;
  const ready = async (): Promise<boolean> => {
    if (!deps.adReadiness) return true;
    readiness ??= deps.adReadiness().catch(() => ({ ok: false as const, code: "meta_ads_lookup_failed" }));
    const r = await readiness;
    if (!r.ok) notes.push(`creatives held: Meta cannot take a new ad yet (${r.code})`);
    return r.ok;
  };

  const notReady = inv.meta.objects.filter(
    (o) =>
      o.level === "ad_set" &&
      o.paused_self &&
      o.parent_active &&
      o.has_ready_ads === false &&
      o.daily_budget_usd !== null &&
      o.daily_budget_usd > 0 &&
      !isRetargeting(o) &&
      !!i.enableSafe?.has(dwellKeyOf("meta", o.id)) &&
      !dwell.has(`creative:${o.id}`),
  );
  let shared: CreativeCopy | null | undefined;
  const conflicted = async (ad_set_id: string) =>
    !!deps.openConflict && (await deps.openConflict(ad_set_id).catch(() => true));
  for (const o of notReady) {
    if (orders.length >= MAX_CREATIVES_PER_RUN) break;
    if (!(await ready())) return { orders, notes };
    if (await conflicted(o.id)) {
      notes.push(`ad for ${o.id} not planned: an open card already names this ad set`);
      continue;
    }
    if (shared === undefined) shared = await firstReadableCopy(deps, prospectingTemplates(inv).map((t) => t.id));
    if (!shared) {
      notes.push(`no live ad with words and a website link to give ${o.id} an ad`);
      break;
    }
    const body = await creativeOrderBody(deps, o.id, shared, true, notes);
    if (!body) continue;
    orders.push({
      channel_slug: "meta_ads",
      exec_class: "meta_ads.create_ad",
      body,
      reason: "Zavi's paused ad set has no ad that can run (rejected or switched off), so it gets a fresh one before it is switched on.",
      dwell_key: `creative:${o.id}`,
      adds_usd: 0,
    });
  }

  const live = inv.meta.objects.filter((o) => o.level === "ad_set" && o.active && o.parent_active && o.has_live_ads === true && !isRetargeting(o) && !i.held?.has(dwellKeyOf("meta", o.id)));
  if (live.length === 0) return { orders, notes };
  let fatigued: ReadonlySet<string> = new Set();
  try {
    fatigued = await deps.fatiguedAdSets(live.map((o) => o.id));
  } catch (e) {
    notes.push(`fatigue unreadable: ${(e as Error).message.slice(0, 80)}`);
  }
  const byCampaign = new Map<string, AdObject[]>();
  for (const o of live) {
    const c = o.campaign_id ?? o.id;
    byCampaign.set(c, [...(byCampaign.get(c) ?? []), o]);
  }
  for (const [campaign, sets] of byCampaign) {
    if (orders.length >= MAX_CREATIVES_PER_RUN) break;
    if (dwell.has(`creative:${campaign}`)) continue;
    const new7d = inv.meta.ads.filter((a) => (a.campaign_id ?? "") === campaign && (hoursSince(a.created_at, now) ?? Infinity) < 7 * 24).length;
    const tired = sets.filter((o) => fatigued.has(o.id)).sort(rank);
    const due = new7d < VARIANTS_LOW || (tired.length > 0 && new7d < VARIANTS_HIGH);
    if (!due) continue;
    const target = tired[0] ?? [...sets].sort(rank)[0]!;
    if (await conflicted(target.id)) {
      notes.push(`ad for ${target.id} not planned: an open card already names this ad set`);
      continue;
    }
    const copy = await firstReadableCopy(deps, [target.id, ...[...sets].sort(rank).map((x) => x.id).filter((id) => id !== target.id)]);
    if (!copy) {
      notes.push(`no live ad with words and a website link in campaign ${campaign}`);
      continue;
    }
    if (!(await ready())) return { orders, notes };
    const body = await creativeOrderBody(deps, target.id, copy, false, notes);
    if (!body) continue;
    orders.push({
      channel_slug: "meta_ads",
      exec_class: "meta_ads.create_ad",
      body,
      reason: tired.includes(target)
        ? "Its ads are wearing out (clicks falling against their own start), so a fresh picture goes in beside them."
        : `This campaign got ${new7d} new ad${new7d === 1 ? "" : "s"} this week; fresh variants keep it from wearing out.`,
      dwell_key: `creative:${campaign}`,
      adds_usd: 0,
    });
  }
  return { orders, notes };
}

const META_LIVE_AD = new Set(["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"]);
const META_DEAD_AD = new Set(["DISAPPROVED", "WITH_ISSUES", "DELETED", "ARCHIVED", "PAUSED"]);

export function metaAdReady(a: { effective_status?: string; configured_status?: string }): boolean {
  const eff = a.effective_status ?? "";
  if (META_LIVE_AD.has(eff)) return true;
  return a.configured_status === "ACTIVE" && !META_DEAD_AD.has(eff);
}

function minorToUsd(minor: string | null | undefined): number | null {
  const n = Number(minor);
  if (minor == null || minor === "" || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n) / 100;
}

function isNotConnected(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.endsWith("_not_connected") || code === "google_ads_not_configured");
}

export const PERF_TTL_MS = 3 * 3_600_000;
export const FATIGUE_TTL_MS = 24 * 3_600_000;
export const AUDIENCE_TTL_MS = 3 * 3_600_000;
export const META_USAGE_BACKOFF_PCT = 90;
const META_USAGE_FRESH_MS = 15 * 60_000;

type Cached<T> = { at: number; value: T };
const perfCache = new Map<string, Cached<MetaPerfRow[]>>();
const fatigueCache = new Map<string, Cached<ReadonlySet<string>>>();
const audienceCache = new Map<string, Cached<WebsiteAudience | null>>();

export function _resetSpendControllerCaches(): void {
  perfCache.clear();
  _resetAccountZones();
  fatigueCache.clear();
  audienceCache.clear();
  _resetMetaCooldowns();
}

export function isMetaRateLimitError(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === "meta_ads_busy") return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const code = /"code"\s*:\s*(\d+)/.exec(msg)?.[1];
  const sub = /"error_subcode"\s*:\s*(\d+)/.exec(msg)?.[1];
  return isMetaRateLimitCode(code, sub);
}

async function metaUsageOf(tenant_id: string): Promise<{ pct: number; regain_minutes: number; at: number } | null> {
  try {
    const { metaUsage } = await import("@/services/tools/meta-ads/_client");
    return typeof metaUsage === "function" ? metaUsage(tenant_id) : null;
  } catch {
    return null;
  }
}

async function metaAccountOf(tenant_id: string): Promise<string | null> {
  try {
    const { metaAdsCreds } = await import("@/services/tools/meta-ads/_client");
    return (await metaAdsCreds(tenant_id)).ad_account_id;
  } catch {
    return null;
  }
}

export async function noteMetaRateLimit(tenant_id: string, now: Date): Promise<void> {
  const account = await metaAccountOf(tenant_id);
  if (!account) return;
  const regain = (await metaUsageOf(tenant_id))?.regain_minutes ?? 0;
  const minutes = regain > 0 ? regain : DEFAULT_COOLDOWN_MINUTES;
  await startMetaCooldown(account, now.getTime() + minutes * 60_000, "spend controller rate limit", now.getTime());
}

export async function metaThrottled(tenant_id: string, now: Date, opts: { allowProbe?: boolean } = {}): Promise<string | null> {
  const account = await metaAccountOf(tenant_id);
  if (account) {
    const until = await metaCoolingUntil(account, now.getTime());
    if (until !== null && !(opts.allowProbe && (await metaProbeAvailable(account, "spend_controller", now.getTime())))) {
      return `Meta rate limit: backing off until ${new Date(until).toISOString().slice(11, 16)} UTC`;
    }
  }
  const u = await metaUsageOf(tenant_id);
  if (u && Date.now() - u.at <= META_USAGE_FRESH_MS && (u.pct >= META_USAGE_BACKOFF_PCT || u.regain_minutes > 0)) {
    return `Meta usage at ${Math.round(u.pct)}% of its limit${u.regain_minutes > 0 ? `, access back in ${u.regain_minutes} min` : ""}`;
  }
  return null;
}

async function metaRead<T>(tenant_id: string, now: Date, fn: () => Promise<T>, opts: { allowProbe?: boolean } = {}): Promise<T> {
  const why = await metaThrottled(tenant_id, now, opts);
  if (why) throw new Error(why);
  try {
    return await withMetaCaller("spend_controller", fn);
  } catch (e) {
    if (isMetaRateLimitError(e)) await noteMetaRateLimit(tenant_id, now);
    throw e;
  }
}

type MetaPerfRow = { ad_set_id: string; date: string; spend_usd: number; conversions: number; purchases: number; purchase_value_usd?: number; clicks: number; judged_on?: string };

async function readMetaPerf(tenant_id: string, account: string, window: { since: string; until: string }): Promise<MetaPerfRow[]> {
  const key = `${tenant_id}:${account}:${window.until}`;
  const hit = perfCache.get(key);
  if (hit && Date.now() - hit.at < PERF_TTL_MS) return hit.value;
  const { fetchMetaDailySeries } = await import("@/services/tools/meta-ads/daily_series");
  const series = await fetchMetaDailySeries(tenant_id, { level: "adset", time_range: window, all_pages: true });
  const rows: MetaPerfRow[] = series.rows
    .filter((r) => !!r.ad_set_id)
    .map((r) => ({ ad_set_id: r.ad_set_id as string, date: r.date, spend_usd: r.spend_usd, conversions: r.conversions, purchases: r.purchases ?? 0, purchase_value_usd: r.purchase_value_usd ?? 0, clicks: r.clicks, judged_on: r.judged_on }));
  perfCache.set(key, { at: Date.now(), value: rows });
  return rows;
}

export const META_ADSET_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "daily_budget",
  "effective_status",
  "configured_status",
  "status",
  "created_time",
  "targeting{custom_audiences}",
  "campaign{id,name,effective_status,status,daily_budget,created_time}",
  "ads.limit(100){id,campaign_id,effective_status,configured_status,created_time}",
].join(",");
const META_AD_FIELDS = "id,campaign_id,effective_status,configured_status,created_time";

export async function readMetaInventory(tenant_id: string, now: Date = new Date()): Promise<Inventory["meta"]> {
  const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
  let account: string;
  try {
    account = (await metaAdsCreds(tenant_id)).ad_account_id;
  } catch (e) {
    if (isNotConnected(e)) return { connected: false, objects: [], ads: [] };
    throw e;
  }
  type Camp = { id?: string; name?: string; effective_status?: string; status?: string; daily_budget?: string | null; created_time?: string };
  type Ad = { id?: string; adset_id?: string; campaign_id?: string; effective_status?: string; configured_status?: string; created_time?: string };
  type Set_ = Omit<Camp, "id"> & {
    id?: string;
    campaign_id?: string;
    configured_status?: string;
    targeting?: { custom_audiences?: Array<{ id?: string }> };
    campaign?: Camp;
    ads?: { data?: Ad[]; paging?: { next?: string } };
  };
  const sets = await fbGetAllPages<Set_>(tenant_id, `${account}/adsets`, { fields: META_ADSET_FIELDS, limit: 50 });
  const camps: Camp[] = [];
  const ads: Ad[] = [];
  const seenCamp = new Set<string>();
  for (const s of sets) {
    if (s.campaign?.id && !seenCamp.has(s.campaign.id)) {
      seenCamp.add(s.campaign.id);
      camps.push(s.campaign);
    }
    if (!s.id) continue;
    const own = s.ads?.paging?.next ? await fbGetAllPages<Ad>(tenant_id, `${s.id}/ads`, { fields: META_AD_FIELDS, limit: 100 }) : (s.ads?.data ?? []);
    for (const a of own) ads.push({ ...a, adset_id: s.id, campaign_id: a.campaign_id ?? s.campaign_id });
  }
  const today = dateInZone(now, await metaAccountZone(tenant_id, account, now));
  const window7 = wholeDaysWindow(today, 7);
  const since3 = wholeDaysWindow(today, OBSERVED_DAYS).since;
  const window10 = wholeDaysWindow(today, 7 + SETTLE_DAYS);
  const settledUntil = wholeDaysWindow(today, SETTLE_DAYS + 1).since;
  const rows = await readMetaPerf(tenant_id, account, window10);
  const perf = new Map<string, { spend: number; spend3: number; days: number; conv: number; bookings: number; value: number; clicks: number; kind: ResultKind; s: { spend: number; conv: number; clicks: number; bookings: number; value: number } }>();
  for (const r of rows) {
    const p = perf.get(r.ad_set_id) ?? { spend: 0, spend3: 0, days: 0, conv: 0, bookings: 0, value: 0, clicks: 0, kind: "conversions" as ResultKind, s: { spend: 0, conv: 0, clicks: 0, bookings: 0, value: 0 } };
    perf.set(r.ad_set_id, p);
    if (r.date <= settledUntil) {
      p.s.spend += r.spend_usd;
      p.s.conv += r.conversions;
      p.s.clicks += r.clicks;
      p.s.bookings += r.purchases;
      p.s.value += r.purchase_value_usd ?? 0;
    }
    if (r.date < window7.since) continue;
    p.spend += r.spend_usd;
    if (r.date >= since3 && r.date <= window7.until) p.spend3 += r.spend_usd;
    if (r.spend_usd > 0) p.days += 1;
    p.conv += r.conversions;
    p.bookings += r.purchases;
    p.value += r.purchase_value_usd ?? 0;
    p.clicks += r.clicks;
    if (r.judged_on === "reach_and_clicks") p.kind = "clicks";
    perf.set(r.ad_set_id, p);
  }
  const adsBySet = new Map<string, Ad[]>();
  for (const a of ads) if (a.adset_id) adsBySet.set(a.adset_id, [...(adsBySet.get(a.adset_id) ?? []), a]);
  const campById = new Map(camps.filter((c) => c.id).map((c) => [c.id as string, c]));
  const isOff = (s?: string) => s === "DELETED" || s === "ARCHIVED";
  const objects: AdObject[] = [];
  const campAgg = new Map<string, { spend: number; spend3: number; days: number; results: number; bookings: number; value: number; kind: ResultKind; live: boolean; any: boolean; ready: boolean; s: { spend: number; results: number; bookings: number; value: number } }>();
  for (const s of sets) {
    if (!s.id || isOff(s.effective_status) || isOff(s.configured_status ?? s.status)) continue;
    const camp = s.campaign_id ? campById.get(s.campaign_id) : undefined;
    const campBudget = minorToUsd(camp?.daily_budget);
    const p = perf.get(s.id);
    const kind = p?.kind ?? "conversions";
    const results = p ? (kind === "clicks" ? p.clicks : p.conv) : 0;
    const setAds = adsBySet.get(s.id) ?? [];
    const liveAds = setAds.some((a) => META_LIVE_AD.has(a.effective_status ?? ""));
    const readyAds = setAds.some(metaAdReady);
    objects.push({
      platform: "meta",
      level: "ad_set",
      id: s.id,
      campaign_id: s.campaign_id ?? null,
      name: s.name ?? null,
      active: s.effective_status === "ACTIVE",
      paused_self: (s.configured_status ?? s.status) === "PAUSED",
      parent_active: camp ? camp.effective_status === "ACTIVE" : false,
      daily_budget_usd: minorToUsd(s.daily_budget),
      budget_on_campaign: campBudget !== null,
      spend7d_usd: round2(p?.spend ?? 0),
      spend3d_usd: round2(p?.spend3 ?? 0),
      spend_days7d: p?.days ?? 0,
      results7d: results,
      result_kind: kind,
      purchases7d: round2(p?.bookings ?? 0),
      purchase_value7d_usd: round2(p?.value ?? 0),
      settled: { spend_usd: round2(p?.s.spend ?? 0), results: p ? (kind === "clicks" ? p.s.clicks : p.s.conv) : 0, purchases: round2(p?.s.bookings ?? 0), purchase_value_usd: round2(p?.s.value ?? 0) },
      has_live_ads: liveAds,
      has_any_ads: setAds.length > 0,
      has_ready_ads: readyAds,
      audience_ids: (s.targeting?.custom_audiences ?? []).map((a) => a.id).filter((x): x is string => typeof x === "string"),
      created_at: s.created_time ?? null,
    });
    if (campBudget !== null && s.campaign_id) {
      const agg = campAgg.get(s.campaign_id) ?? { spend: 0, spend3: 0, days: 0, results: 0, bookings: 0, value: 0, kind, live: false, any: false, ready: false, s: { spend: 0, results: 0, bookings: 0, value: 0 } };
      agg.s.spend += p?.s.spend ?? 0;
      agg.s.results += p ? (kind === "clicks" ? p.s.clicks : p.s.conv) : 0;
      agg.s.bookings += p?.s.bookings ?? 0;
      agg.s.value += p?.s.value ?? 0;
      agg.spend += p?.spend ?? 0;
      agg.spend3 += p?.spend3 ?? 0;
      agg.days = Math.max(agg.days, p?.days ?? 0);
      agg.results += results;
      agg.bookings += p?.bookings ?? 0;
      agg.value += p?.value ?? 0;
      agg.live ||= liveAds && s.effective_status === "ACTIVE";
      agg.any ||= setAds.length > 0;
      agg.ready ||= readyAds && (s.configured_status ?? s.status) === "ACTIVE";
      campAgg.set(s.campaign_id, agg);
    }
  }
  for (const c of camps) {
    const b = minorToUsd(c.daily_budget);
    if (!c.id || b === null || isOff(c.effective_status) || isOff(c.status)) continue;
    const agg = campAgg.get(c.id);
    objects.push({
      platform: "meta",
      level: "campaign",
      id: c.id,
      campaign_id: c.id,
      name: c.name ?? null,
      active: c.effective_status === "ACTIVE",
      paused_self: c.status === "PAUSED",
      parent_active: true,
      daily_budget_usd: b,
      budget_on_campaign: false,
      spend7d_usd: round2(agg?.spend ?? 0),
      spend3d_usd: round2(agg?.spend3 ?? 0),
      spend_days7d: agg?.days ?? 0,
      results7d: agg?.results ?? 0,
      result_kind: agg?.kind ?? "conversions",
      purchases7d: round2(agg?.bookings ?? 0),
      purchase_value7d_usd: round2(agg?.value ?? 0),
      settled: { spend_usd: round2(agg?.s.spend ?? 0), results: agg?.s.results ?? 0, purchases: round2(agg?.s.bookings ?? 0), purchase_value_usd: round2(agg?.s.value ?? 0) },
      has_live_ads: agg?.live ?? false,
      has_any_ads: agg?.any ?? false,
      has_ready_ads: agg?.ready ?? false,
      audience_ids: [],
      created_at: c.created_time ?? null,
    });
  }
  return {
    connected: true,
    objects,
    ads: ads
      .filter((a) => a.id && a.adset_id)
      .map((a) => ({ id: a.id as string, ad_set_id: a.adset_id as string, campaign_id: a.campaign_id ?? null, live: META_LIVE_AD.has(a.effective_status ?? ""), created_at: a.created_time ?? null })),
  };
}

type GRow = {
  campaign?: { id?: string | number; name?: string; status?: string; startDateTime?: string; advertisingChannelType?: string };
  campaignBudget?: { amountMicros?: string | number; period?: string; explicitlyShared?: boolean };
  metrics?: { costMicros?: string | number; conversions?: string | number; conversionsValue?: string | number; clicks?: string | number };
  segments?: { date?: string };
};

function zoneOffsetMs(utcMs: number, time_zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: time_zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - Math.floor(utcMs / 1000) * 1000;
}

export function googleStartToIso(v: string | null | undefined, time_zone?: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(v ?? "");
  if (!m) return null;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (!Number.isFinite(local)) return null;
  let utc = local;
  if (time_zone) {
    try {
      utc = local - zoneOffsetMs(local, time_zone);
      utc = local - zoneOffsetMs(utc, time_zone);
    } catch {
      utc = local;
    }
  }
  return new Date(utc).toISOString().replace(".000Z", "Z");
}

export async function readGoogleInventory(tenant_id: string): Promise<Inventory["google"]> {
  const { gadsCustomerId, gadsSearch } = await import("@/services/tools/google-ads/_client");
  const { accountClock, shiftDate } = await import("@/services/tools/google-ads/_read-window");
  let customer: string;
  try {
    customer = await gadsCustomerId(tenant_id);
  } catch (e) {
    if (isNotConnected(e)) return { connected: false, objects: [], conversions30d: null };
    throw e;
  }
  const camps = (await gadsSearch(
    tenant_id,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.period, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'",
    { complete: true },
  )) as GRow[];
  const clock = await accountClock(tenant_id, (q) => gadsSearch(tenant_id, q));
  rememberAccountZone(tenant_id, "google", customer, clock.time_zone);
  const end = shiftDate(clock.date, -1);
  const start7 = shiftDate(end, -6);
  const start3 = shiftDate(end, 1 - OBSERVED_DAYS);
  const start10 = shiftDate(end, -(6 + SETTLE_DAYS));
  const settledEnd = shiftDate(end, -SETTLE_DAYS);
  const perfRows = (await gadsSearch(
    tenant_id,
    `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.conversions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${start10}' AND '${end}' AND campaign.status != 'REMOVED'`,
    { complete: true },
  )) as GRow[];
  const bookings = new Map<string, { n: number; value: number; sn: number; svalue: number }>();
  let purchases_unread = false;
  try {
    const bookRows = (await gadsSearch(
      tenant_id,
      `SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${start10}' AND '${end}' AND segments.conversion_action_category = 'PURCHASE' AND campaign.status != 'REMOVED'`,
      { complete: true },
    )) as GRow[];
    for (const r of bookRows) {
      const id = r.campaign?.id != null ? String(r.campaign.id) : "";
      if (!id) continue;
      const b = bookings.get(id) ?? { n: 0, value: 0, sn: 0, svalue: 0 };
      const n = Number(r.metrics?.conversions ?? 0) || 0;
      const v = Number(r.metrics?.conversionsValue ?? 0) || 0;
      const day = r.segments?.date ?? "";
      if (day <= settledEnd) {
        b.sn += n;
        b.svalue += v;
      }
      if (day >= start7) {
        b.n += n;
        b.value += v;
      }
      bookings.set(id, b);
    }
  } catch (e) {
    bookings.clear();
    purchases_unread = true;
    console.warn(`[spend-controller] google bookings unread for ${tenant_id}: ${(e as Error).message}`);
  }
  const { readGoogleBrandCampaignIds, couldBeBrandSearch } = await import("./ad-goal-match");
  const brandRead = await readGoogleBrandCampaignIds(tenant_id);
  const brandIds = "ids" in brandRead ? brandRead.ids : null;
  let conversions30d: number | null = null;
  try {
    const acct = (await gadsSearch(tenant_id, "SELECT metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS", { complete: true })) as GRow[];
    conversions30d = acct.reduce((s, r) => s + (Number(r.metrics?.conversions ?? 0) || 0), 0);
  } catch {
    conversions30d = null;
  }
  const perf = new Map<string, { spend: number; spend3: number; days: number; conv: number; clicks: number; s: { spend: number; conv: number; clicks: number } }>();
  for (const r of perfRows) {
    const id = r.campaign?.id != null ? String(r.campaign.id) : "";
    if (!id) continue;
    const p = perf.get(id) ?? { spend: 0, spend3: 0, days: 0, conv: 0, clicks: 0, s: { spend: 0, conv: 0, clicks: 0 } };
    perf.set(id, p);
    const spend = (Number(r.metrics?.costMicros ?? 0) || 0) / 1_000_000;
    const day = r.segments?.date ?? "";
    if (day <= settledEnd) {
      p.s.spend += spend;
      p.s.conv += Number(r.metrics?.conversions ?? 0) || 0;
      p.s.clicks += Number(r.metrics?.clicks ?? 0) || 0;
    }
    if (day < start7) continue;
    p.spend += spend;
    if (day >= start3 && day <= end) p.spend3 += spend;
    if (spend > 0) p.days += 1;
    p.conv += Number(r.metrics?.conversions ?? 0) || 0;
    p.clicks += Number(r.metrics?.clicks ?? 0) || 0;
    perf.set(id, p);
  }
  const objects: AdObject[] = [];
  for (const r of camps) {
    const id = r.campaign?.id != null ? String(r.campaign.id) : "";
    if (!/^\d+$/.test(id)) continue;
    const b = r.campaignBudget;
    const daily = b && b.explicitlyShared !== true && b.period === "DAILY" && b.amountMicros != null ? Math.round(Number(b.amountMicros) / 10_000) / 100 : null;
    const p = perf.get(id);
    const kind: ResultKind = p && (p.conv > 0 || p.s.conv > 0) ? "conversions" : "clicks";
    const booked = bookings.get(id);
    objects.push({
      platform: "google",
      level: "campaign",
      id,
      campaign_id: id,
      name: r.campaign?.name ?? null,
      active: r.campaign?.status === "ENABLED",
      paused_self: r.campaign?.status === "PAUSED",
      parent_active: true,
      daily_budget_usd: daily !== null && daily > 0 ? daily : null,
      budget_on_campaign: false,
      spend7d_usd: round2(p?.spend ?? 0),
      spend3d_usd: round2(p?.spend3 ?? 0),
      spend_days7d: p?.days ?? 0,
      results7d: p ? (kind === "conversions" ? p.conv : p.clicks) : 0,
      result_kind: kind,
      purchases7d: round2(booked?.n ?? 0),
      purchase_value7d_usd: round2(booked?.value ?? 0),
      settled: { spend_usd: round2(p?.s.spend ?? 0), results: p ? (kind === "conversions" ? p.s.conv : p.s.clicks) : 0, purchases: round2(booked?.sn ?? 0), purchase_value_usd: round2(booked?.svalue ?? 0) },
      ...(brandIds ? (brandIds.has(id) ? { brand: true } : {}) : couldBeBrandSearch(r.campaign?.advertisingChannelType) ? { brand: true } : {}),
      ...(r.campaign?.advertisingChannelType ? { channel_type: r.campaign.advertisingChannelType } : {}),
      has_live_ads: null,
      has_any_ads: null,
      has_ready_ads: null,
      audience_ids: [],
      created_at: googleStartToIso(r.campaign?.startDateTime, clock.time_zone),
    });
  }
  const dayAgo = Date.now() - 24 * 3_600_000;
  const stuck = objects.filter((o) => o.active && o.spend7d_usd === 0 && (!o.created_at || new Date(o.created_at).getTime() <= dayAgo));
  if (stuck.length > 0) {
    try {
      const { readEnabledServing, servingWhy } = await import("@/services/tools/google-ads/_serving-status");
      const serving = await readEnabledServing(tenant_id);
      for (const o of stuck) {
        const s = serving.get(o.id);
        if (s) o.not_serving = servingWhy(s);
      }
    } catch (e) {
      console.warn(`[spend-controller] google serving status unread for ${tenant_id}: ${(e as Error).message}`);
    }
  }
  return { connected: true, objects, conversions30d, ...(purchases_unread ? { purchases_unread: true } : {}), ...("error" in brandRead ? { brand_unread: true, brand_unread_why: brandRead.error } : {}) };
}

export async function readWebsiteAudience(tenant_id: string): Promise<WebsiteAudience | null> {
  const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
  const account = (await metaAdsCreds(tenant_id)).ad_account_id;
  type Row = { id?: string; subtype?: string; approximate_count_lower_bound?: number };
  const rows = await fbGetAllPages<Row>(tenant_id, `${account}/customaudiences`, { fields: "id,subtype,approximate_count_lower_bound", limit: 200 });
  const web = rows
    .filter((r) => r.id && r.subtype === "WEBSITE")
    .map((r) => ({ id: r.id as string, count: typeof r.approximate_count_lower_bound === "number" && r.approximate_count_lower_bound >= 0 ? r.approximate_count_lower_bound : null }))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  return web[0] ?? null;
}

export async function readCreativeCopy(tenant_id: string, ad_set_id: string): Promise<CreativeCopy | null> {
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  type Spec = {
    link_data?: { message?: string; name?: string; link?: string; call_to_action?: { type?: string } };
    video_data?: { message?: string; title?: string; call_to_action?: { type?: string; value?: { link?: string } } };
  };
  type Feed = { bodies?: Array<{ text?: string }>; titles?: Array<{ text?: string }>; link_urls?: Array<{ website_url?: string }>; call_to_action_types?: string[] };
  type Row = { id?: string; effective_status?: string; creative?: { object_story_spec?: Spec; asset_feed_spec?: Feed; call_to_action_type?: string } };
  const j = (await fbGet(tenant_id, `${ad_set_id}/ads`, { fields: "id,effective_status,creative{object_story_spec,asset_feed_spec,call_to_action_type}", limit: 25 })) as { data?: Row[] };
  const rows = (j.data ?? []).sort((a, b) => Number(b.effective_status === "ACTIVE") - Number(a.effective_status === "ACTIVE"));
  for (const r of rows) {
    const c = r.creative;
    if (!r.id || !c) continue;
    const ld = c.object_story_spec?.link_data;
    const vd = c.object_story_spec?.video_data;
    const feed = c.asset_feed_spec;
    const primary_text = ld?.message ?? vd?.message ?? feed?.bodies?.[0]?.text ?? "";
    const headline = ld?.name ?? vd?.title ?? feed?.titles?.[0]?.text ?? "";
    const link_url = ld?.link ?? vd?.call_to_action?.value?.link ?? feed?.link_urls?.[0]?.website_url ?? "";
    const cta = ld?.call_to_action?.type ?? vd?.call_to_action?.type ?? feed?.call_to_action_types?.[0] ?? c.call_to_action_type;
    const copy = normalizeCreativeCopy({ source_ad_id: r.id, primary_text, headline, link_url, ...(cta ? { cta } : {}) });
    if (copy) return copy;
  }
  return null;
}

export async function readAdSetSetup(tenant_id: string, ad_set_id: string): Promise<AdSetSetup | null> {
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  const j = (await fbGet(tenant_id, ad_set_id, { fields: "campaign_id,optimization_goal,billing_event,promoted_object,targeting" })) as {
    campaign_id?: string;
    optimization_goal?: string;
    billing_event?: string;
    promoted_object?: Record<string, unknown>;
    targeting?: { geo_locations?: Record<string, unknown> };
  };
  if (!j.campaign_id || !j.optimization_goal || !j.billing_event) return null;
  return { campaign_id: j.campaign_id, optimization_goal: j.optimization_goal, billing_event: j.billing_event, promoted_object: j.promoted_object ?? null, geo_locations: j.targeting?.geo_locations ?? null };
}

export async function readFatiguedAdSets(tenant_id: string, ad_set_ids: string[], now: Date): Promise<ReadonlySet<string>> {
  if (ad_set_ids.length === 0) return new Set();
  const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
  const { mapMetaDailyRow } = await import("@/services/tools/meta-ads/daily_series");
  const { adFatigue } = await import("./ad-fatigue");
  const account = (await metaAdsCreds(tenant_id)).ad_account_id;
  const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
  type Row = { ad_id?: string; adset_id?: string; date_start?: string; spend?: string; impressions?: string; clicks?: string };
  const rows = await fbGetAllPages<Row>(tenant_id, `${account}/insights`, {
    level: "ad",
    time_range: JSON.stringify({ since: day(21), until: day(1) }),
    time_increment: 1,
    limit: 500,
    fields: "date_start,ad_id,adset_id,campaign_id,spend,impressions,clicks,actions,action_values",
    filtering: JSON.stringify([{ field: "adset.id", operator: "IN", value: ad_set_ids }]),
  });
  const byAd = new Map<string, { ad_set_id: string; days: Array<{ date: string; impressions: number; clicks: number; spend_usd: number; results: number }> }>();
  for (const r of rows) {
    if (!r.ad_id || !r.adset_id || !r.date_start) continue;
    const m = mapMetaDailyRow(r as Parameters<typeof mapMetaDailyRow>[0]);
    const e = byAd.get(r.ad_id) ?? { ad_set_id: r.adset_id, days: [] };
    e.days.push({ date: m.date, impressions: m.impressions, clicks: m.clicks, spend_usd: m.spend_usd, results: m.conversions });
    byAd.set(r.ad_id, e);
  }
  const out = new Set<string>();
  for (const [ad_id, e] of byAd) {
    if (adFatigue({ ad_id, days: e.days }).fatigue === "fatigued") out.add(e.ad_set_id);
  }
  return out;
}

export async function cachedFatiguedAdSets(tenant_id: string, ad_set_ids: string[], now: Date): Promise<ReadonlySet<string>> {
  const hit = fatigueCache.get(tenant_id);
  if (hit && Date.now() - hit.at < FATIGUE_TTL_MS) return new Set(ad_set_ids.filter((id) => hit.value.has(id)));
  const fatigued = await metaRead(tenant_id, now, () => readFatiguedAdSets(tenant_id, ad_set_ids, now));
  fatigueCache.set(tenant_id, { at: Date.now(), value: fatigued });
  return fatigued;
}

export async function cachedWebsiteAudience(tenant_id: string, now: Date): Promise<WebsiteAudience | null> {
  const hit = audienceCache.get(tenant_id);
  if (hit && Date.now() - hit.at < AUDIENCE_TTL_MS) return hit.value;
  const value = await metaRead(tenant_id, now, () => readWebsiteAudience(tenant_id));
  audienceCache.set(tenant_id, { at: Date.now(), value });
  return value;
}

export const LEDGER_FRESH_HOURS = 6;

async function connectedAccountId(tenant_id: string, platform: "meta" | "google"): Promise<string | null> {
  try {
    if (platform === "meta") return (await (await import("@/services/tools/meta-ads/_client")).metaAdsCreds(tenant_id)).ad_account_id;
    return await (await import("@/services/tools/google-ads/_client")).gadsCustomerId(tenant_id);
  } catch {
    return null;
  }
}

export async function readLedgerCapacity(tenant_id: string, platform: "meta" | "google", now: Date): Promise<number | null> {
  const account = await connectedAccountId(tenant_id, platform);
  if (!account) return null;
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { forecastDailySpend } = await import("@/services/growth/spend-pace");
  const svc = tenantClient(asTenantId(tenant_id));
  const fresh = new Date(now.getTime() - LEDGER_FRESH_HOURS * 3_600_000).toISOString();
  const zone = knownAccountZone(tenant_id, platform, account, now);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (OBSERVED_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  const [objects, spend, holds] = await Promise.all([
    svc
      .from("ad_campaigns")
      .select("platform, object_id, status, budget_kind, budget_usd")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("account_id", account)
      .gte("as_of", fresh)
      .limit(2000),
    svc
      .from("ad_spend_daily")
      .select("platform, object_id, spend_date, amount_usd")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("account_id", account)
      .gte("spend_date", since)
      .limit(10000),
    svc
      .from("ad_budget_reservations")
      .select("platform, object_id, created_at")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .in("status", ["reserved", "committed"])
      .gte("created_at", new Date(now.getTime() - RAMP_HOURS * 3_600_000).toISOString())
      .limit(500),
  ]);
  for (const r of [objects, spend, holds]) if (r.error) throw new Error(`ad-spend-controller: ledger read failed: ${r.error.message}`);
  if (!objects.data || objects.data.length === 0) return null;
  type F = Parameters<typeof forecastDailySpend>[0];
  return forecastDailySpend({
    objects: objects.data as unknown as F["objects"],
    spend: (spend.data ?? []) as unknown as F["spend"],
    holds: (holds.data ?? []) as unknown as F["holds"],
    now,
    today: zone ? { [platform]: dateInZone(now, zone) } : undefined,
  }).forecast_daily_usd;
}

export async function generateAdImage(tenant_id: string, copy: CreativeCopy, now: Date): Promise<string | null> {
  const { ensureCgoOrderRun } = await import("./cgo-ad-orders");
  const run_id = await ensureCgoOrderRun(tenant_id, "meta_ads", now);
  const { deliverImage } = await import("@/services/reports/deliver-image");
  const prompt = `A bright, realistic square photo for an ad with the headline "${copy.headline.slice(0, 120)}". What it is about: ${copy.primary_text.slice(0, 300)}. No words, letters or logos in the picture.`;
  const r = await deliverImage({ tenant_id, run_id, stageable: true }, { prompts: [{ prompt, filename: "zavi-ad-variant" }], aspect_ratio: "1:1", mode: "photo" });
  const path = r.images[0]?.image_path;
  if (!path) return null;
  const { signOwnImageForVendor } = await import("@/services/chat-images/sign-own-image");
  return signOwnImageForVendor(tenant_id, path, 2 * 3600);
}

type OrderRow = {
  body?: { cgo_dwell_key?: unknown } | null;
  exec_status?: string | null;
  status?: string | null;
  exec_result?: Record<string, unknown> | null;
  proposed_at?: string | null;
  exec_claimed_at?: string | null;
  executed_at?: string | null;
};

export function orderLastTouchedMs(r: Pick<OrderRow, "proposed_at" | "exec_claimed_at" | "executed_at">): number | null {
  const ts = [r.proposed_at, r.exec_claimed_at, r.executed_at].map((v) => (typeof v === "string" ? Date.parse(v) : NaN)).filter((n) => Number.isFinite(n));
  return ts.length ? Math.max(...ts) : null;
}

const DEFINITE_FAILURE_BUCKETS: ReadonlySet<string> = new Set(["blocked_on_us", "needs_founder"]);

export function orderDefinitelyFailed(r: OrderRow): boolean {
  if (r.exec_status !== "failed") return false;
  const res = r.exec_result ?? {};
  if (isMakeRoomRefusal(res.error)) return true;
  if (isPartialRiskExecCode(res.code) || res.bucket === "partial_risk") return false;
  if (res.interrupted === true || res.lease_expired === true || res.held_for_founder === true) return false;
  if (res.fix === "ad_budget") return false;
  return typeof res.bucket === "string" && DEFINITE_FAILURE_BUCKETS.has(res.bucket);
}

export function isMakeRoomRefusal(error: unknown): boolean {
  const e = typeof error === "string" ? error : "";
  return e.startsWith("cgo_not_authorized") && /\bmake_room_(test_changed|unverified)\b/.test(e);
}

export async function readRecentOrderKeys(tenant_id: string, now: Date, hours: number): Promise<Set<string>> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { CGO_ORDER_ORIGIN } = await import("./cgo-ad-orders");
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("body, exec_status, status, exec_result, proposed_at, exec_claimed_at, executed_at")
    .eq(`body->>${CGO_ORDER_ORIGIN}`, "ad_spend_controller")
    .or(`proposed_at.gte.${since},exec_claimed_at.gte.${since},executed_at.gte.${since}`)
    .limit(500);
  if (error) throw new Error(`ad-spend-controller: recent orders read failed: ${error.message}`);
  const sinceMs = Date.parse(since);
  const out = new Set<string>();
  for (const r of (data ?? []) as OrderRow[]) {
    if (orderDefinitelyFailed(r)) continue;
    const at = orderLastTouchedMs(r);
    if (at !== null && at < sinceMs) continue;
    const k = r.body?.cgo_dwell_key;
    if (typeof k === "string" && k) out.add(k);
  }
  return out;
}

export type RejectHold = { key: string; dwell_key: string; kind: string; note: string | null; rejected_at: string;  fresh: boolean };

type RejectedRow = { body?: { cgo_dwell_key?: unknown } | null; exec_class?: string | null; exec_payload?: Record<string, unknown> | null; status?: string | null; status_at?: string | null; note?: string | null };

export function rejectedOrderHolds(rows: readonly RejectedRow[], now: Date): RejectHold[] {
  const out = new Map<string, RejectHold>();
  for (const r of rows) {
    const key = r.body?.cgo_dwell_key;
    if (r.status !== "rejected" || typeof key !== "string" || !key || !r.exec_class || !r.status_at) continue;
    const t = Date.parse(r.status_at);
    const age = (now.getTime() - t) / 3_600_000;
    if (!Number.isFinite(t) || age >= REJECTED_ORDER_DAYS * 24) continue;
    const { kind, cut } = orderKindOf(r.exec_class, r.exec_payload);
    if (cut) continue;
    const hold = { key: `${key}|${kind}`, dwell_key: key, kind, note: r.note?.trim() || null, rejected_at: new Date(t).toISOString(), fresh: age >= 0 && age < 1.5 };
    const prev = out.get(hold.key);
    if (!prev || prev.rejected_at < hold.rejected_at) out.set(hold.key, hold);
  }
  return [...out.values()];
}

const REJECTED_READ_CAP = 500;

export async function readRejectedOrderHolds(tenant_id: string, now: Date): Promise<RejectHold[]> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { CGO_ORDER_ORIGIN } = await import("./cgo-ad-orders");
  const since = new Date(now.getTime() - REJECTED_ORDER_DAYS * 24 * 3_600_000).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("body, exec_class, exec_payload, status, status_at, note")
    .eq(`body->>${CGO_ORDER_ORIGIN}`, "ad_spend_controller")
    .eq("status", "rejected")
    .gte("status_at", since)
    .limit(REJECTED_READ_CAP + 1);
  if (error) throw new Error(`ad-spend-controller: rejected orders read failed: ${error.message}`);
  if ((data ?? []).length > REJECTED_READ_CAP) throw new Error("ad-spend-controller: rejected orders read hit its cap");
  return rejectedOrderHolds((data ?? []) as RejectedRow[], now);
}

export function withoutRejected(planned: readonly PlannedOrder[], holds: ReadonlySet<string> | null): { orders: PlannedOrder[]; held: PlannedOrder[] } {
  const orders: PlannedOrder[] = [];
  const held: PlannedOrder[] = [];
  for (const o of planned) {
    const { cut } = orderKindOf(o.exec_class, o.body);
    (!cut && (holds === null || holds.has(rejectHoldKey(o.dwell_key, o.exec_class, o.body))) ? held : orders).push(o);
  }
  return { orders, held };
}

export type OrderBackoff = { dwell_key: string; why: string; failed_at: string;  fresh: boolean };

type BackoffRow = OrderRow & { proposed_at?: string | null; executed_at?: string | null; exec_claimed_at?: string | null };

const BODY_INVALID = /\bbody invalid:/;

export function deterministicBackoffs(rows: readonly BackoffRow[], now: Date): OrderBackoff[] {
  const at = (r: BackoffRow) => r.exec_claimed_at ?? r.executed_at ?? r.proposed_at ?? null;
  const sorted = rows
    .filter((r) => typeof r.body?.cgo_dwell_key === "string" && !!at(r))
    .sort((a, b) => Date.parse(at(a)!) - Date.parse(at(b)!));
  const seen = new Map<string, number>();
  const out = new Map<string, OrderBackoff>();
  for (const r of sorted) {
    const key = r.body!.cgo_dwell_key as string;
    if (r.exec_status === "executed") {
      for (const k of [...seen.keys()]) if (k.startsWith(`${key}|`)) seen.delete(k);
      out.delete(key);
      continue;
    }
    const bucket = r.exec_result?.bucket;
    if (r.exec_status !== "failed" || !(bucket === "blocked_on_us" || (bucket === "needs_founder" && (r.exec_result?.fix === "audience_terms" || r.exec_result?.platform_code === META_OBJECT_UNREACHABLE)))) continue;
    const res = r.exec_result ?? {};
    const error = typeof res.error === "string" ? res.error : "";
    let why: string | null = null;
    if (BODY_INVALID.test(error)) {
      why = `the order was invalid (${error.slice(0, 160)})`;
    } else {
      const sig = typeof res.platform_code === "string" && res.platform_code ? res.platform_code : typeof res.code === "string" && res.code ? res.code : null;
      if (sig) {
        const n = (seen.get(`${key}|${sig}`) ?? 0) + 1;
        seen.set(`${key}|${sig}`, n);
        if (n >= 2) why = `refused twice with ${sig}`;
      }
    }
    if (!why) continue;
    const t = Date.parse(at(r)!);
    const age = (now.getTime() - t) / 3_600_000;
    if (age >= DWELL_HOURS) continue;
    out.set(key, { dwell_key: key, why, failed_at: new Date(t).toISOString(), fresh: age >= 0 && age < 1.5 });
  }
  return [...out.values()];
}

export async function readOrderBackoffs(tenant_id: string, now: Date): Promise<OrderBackoff[]> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { CGO_ORDER_ORIGIN } = await import("./cgo-ad-orders");
  const since = new Date(now.getTime() - 2 * DWELL_HOURS * 3_600_000).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("body, exec_status, status, exec_result, proposed_at, executed_at, exec_claimed_at")
    .eq(`body->>${CGO_ORDER_ORIGIN}`, "ad_spend_controller")
    .in("exec_status", ["failed", "executed"])
    .gte("proposed_at", since)
    .limit(500);
  if (error) throw new Error(`ad-spend-controller: failed orders read failed: ${error.message}`);
  return deterministicBackoffs((data ?? []) as BackoffRow[], now);
}

export type ControllerDeps = {
  businessPolicy?: typeof import("./business-control-policy").readBusinessPolicy;
  monitorBudgetTests?: (tenant_id: string, now: Date) => Promise<unknown>;
  readXCapacity?: (tenant_id: string, now: Date) => Promise<{ connected: boolean; capacity_usd: number | null }>;
  readTiktokCapacity?: (tenant_id: string, now: Date) => Promise<{ connected: boolean; capacity_usd: number | null }>;
  readRedditCapacity?: (tenant_id: string, now: Date) => Promise<{ connected: boolean; capacity_usd: number | null }>;
  cgoAdBudget: (tenant_id: string, now: Date) => Promise<unknown | null>;
  loadSpendPace: (tenant_id: string, now: Date) => Promise<SpendPace | null>;
  readMeta: (tenant_id: string, now: Date) => Promise<Inventory["meta"]>;
  readGoogle: (tenant_id: string) => Promise<Inventory["google"]>;
  goalMode?: (tenant_id: string) => Promise<AdGoalRead>;
  recentOrderKeys: (tenant_id: string, now: Date, hours: number) => Promise<Set<string>>;
  orderBackoffs?: (tenant_id: string, now: Date) => Promise<OrderBackoff[]>;
  rejectedHolds?: (tenant_id: string, now: Date) => Promise<RejectHold[]>;
  enableSafe: (tenant_id: string, objects: AdObject[]) => Promise<Set<string>>;
  businessRulesOff?: () => Promise<boolean>;
  trackingOk?: (tenant_id: string, platform: "meta" | "google") => Promise<boolean>;
  cutLocked?: (tenant_id: string, o: AdObject, now: Date) => Promise<boolean>;
  askFounder?: (tenant_id: string, topic: string, ask: string) => Promise<boolean>;
  businessShape?: (tenant_id: string) => Promise<string | null>;
  copyRegions?: (tenant_id: string, inv: Inventory, now: Date) => Promise<CopyTargets>;
  copyIds?: (tenant_id: string, objects: readonly AdObject[]) => Promise<Set<string>>;
  cgoPauseHolds?: (tenant_id: string, now: Date) => Promise<Set<string>>;
  submit: (input: CgoAdOrderInput) => Promise<CgoAdOrderResult>;
  wakeCgo: (tenant_id: string, now: Date) => Promise<{ woke: boolean; why?: string }>;
  noteStale?: (tenant_id: string, now: Date) => Promise<void>;
  noteCannotDeliver?: (tenant_id: string, objects: readonly AdObject[], now: Date) => Promise<void>;
  retarget: (tenant_id: string, now: Date) => RetargetDeps;
  creative: (tenant_id: string, now: Date) => CreativeDeps;
  ledgerCapacity: (tenant_id: string, platform: "meta" | "google", now: Date) => Promise<number | null>;
  metaThrottled: (tenant_id: string, now: Date, opts?: { allowProbe?: boolean }) => Promise<string | null>;
  noteMetaRateLimit: (tenant_id: string, now: Date) => Promise<void>;
  maintainHolds: (tenant_id: string, now: Date) => Promise<unknown>;
  pendingTestRoom?: (tenant_id: string, now: Date) => Promise<import("./pending-tests").PendingRoom | null>;
  makeRoomNeed?: (tenant_id: string, now: Date) => Promise<import("./pending-test-room-cuts").MakeRoomNeed | null>;
  objectHolds?: (tenant_id: string, budget_id: string) => Promise<Map<string, import("./pending-test-room-cuts").ObjectHold>>;
  makeRoomGate?: (tenant_id: string, order: PlannedOrder, now: Date) => Promise<{ ok: boolean; reasons: string[] }>;
  log: (tenant_id: string, code: string, message: string) => void;
};

export async function heldByCgoPause(
  tenant_id: string,
  inv: Inventory,
  now: Date,
  deps: Pick<ControllerDeps, "cgoPauseHolds" | "log">,
): Promise<{ keys: Set<string>; unread: boolean }> {
  const objects = [...inv.meta.objects, ...inv.google.objects];
  if (!deps.cgoPauseHolds) return { keys: new Set(), unread: false };
  const { holdKey, CGO_PAUSE_HOLD_DAYS } = await import("./cgo-pause-hold");
  let ids: Set<string> | null;
  try {
    ids = await deps.cgoPauseHolds(tenant_id, now);
  } catch (e) {
    deps.log(tenant_id, "cgo.spend_controller_pause_holds_unread", `nothing is raised, switched on or copied this hour: ${(e as Error).message}`);
    ids = null;
  }
  const out = new Set<string>();
  for (const o of objects) {
    const mine = ids === null || ids.has(holdKey(o.platform, o.id)) || (!!o.campaign_id && ids.has(holdKey(o.platform, o.campaign_id)));
    if (mine) out.add(dwellKeyOf(o.platform, o.id));
  }
  if (ids !== null && out.size > 0) deps.log(tenant_id, "cgo.spend_controller_pause_holds", `${out.size} object${out.size === 1 ? "" : "s"} Autopilot paused in the last ${CGO_PAUSE_HOLD_DAYS} days: not raised, switched on or copied`);
  return { keys: out, unread: ids === null };
}

const COPY_CLASSES = ["meta_ads.duplicate_ad_set", "meta_ads.duplicate_campaign"];

const COPY_READ_CAP = 1000;

export async function readCopyIds(tenant_id: string, objects: readonly AdObject[] = []): Promise<Set<string>> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const [ca, ds] = await Promise.all([
    db.from("channel_actions").select("id").eq("tenant_id", tenant_id).in("exec_class", COPY_CLASSES).limit(COPY_READ_CAP),
    db.from("decisions").select("id").eq("tenant_id", tenant_id).in("decision_class", COPY_CLASSES).limit(COPY_READ_CAP),
  ]);
  if (ca.error) throw new Error(`ad-spend-controller: copy actions read failed: ${ca.error.message}`);
  if (ds.error) throw new Error(`ad-spend-controller: copy decisions read failed: ${ds.error.message}`);
  if ((ca.data ?? []).length >= COPY_READ_CAP || (ds.data ?? []).length >= COPY_READ_CAP) throw new Error("ad-spend-controller: copy history over the read cap");
  const actionIds = [...((ca.data ?? []) as Array<{ id: string }>), ...((ds.data ?? []) as Array<{ id: string }>)].map((a) => a.id);
  if (actionIds.length === 0) return new Set();
  const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
  const tags = actionIds.flatMap((id) => {
    try {
      return [launchTag(id)];
    } catch {
      return [];
    }
  });
  const byTag = objects.filter((o) => o.platform === "meta" && !!o.name && tags.some((t) => o.name!.includes(t))).map((o) => o.id);
  const keys = actionIds.map((id) => `${id}:create`);
  const holds: Array<{ object_id: string | null }> = [];
  for (let i = 0; i < keys.length; i += 50) {
    const { data, error: hErr } = await db
      .from("ad_budget_reservations")
      .select("object_id")
      .eq("tenant_id", tenant_id)
      .eq("platform", "meta")
      .eq("op", "create")
      .in("idem_key", keys.slice(i, i + 50))
      .limit(COPY_READ_CAP);
    if (hErr) throw new Error(`ad-spend-controller: copy holds read failed: ${hErr.message}`);
    holds.push(...((data ?? []) as Array<{ object_id: string | null }>));
  }
  return new Set([...holds.map((h) => h.object_id).filter((x): x is string => !!x), ...byTag]);
}

type SavedVerdict = (o: AdObject, window: "7d" | "settled") => string;

async function savedVerdictOf(
  tenant_id: string,
  policy: import("./business-control-policy").SavedBusinessPolicy,
  goal: AdGoalRead,
  now: Date,
  rawMeta: AdObject[],
  deps: Pick<ControllerDeps, "trackingOk">,
): Promise<SavedVerdict> {
  const { judgeBusinessResult } = await import("./business-control-policy");
  const { businessEvidence, reachOrClickIds } = await import("./business-control-runtime");
  const clicks = reachOrClickIds(rawMeta);
  const ok = deps.trackingOk ?? (async () => false);
  const [meta, google] = await Promise.all([ok(tenant_id, "meta").catch(() => false), ok(tenant_id, "google").catch(() => false)]);
  const matches = goal.ok && goal.mode !== "native";
  return (o, window) => {
    const s = o.settled;
    if (window === "settled" && !s) return "unknown";
    const view = window === "settled" && s ? { ...o, spend7d_usd: s.spend_usd, purchases7d: s.purchases, purchase_value7d_usd: s.purchase_value_usd } : o;
    const judged = o.platform === "meta" && clicks.has(o.id) ? { ...view, result_kind: "clicks" as const } : view;
    return judgeBusinessResult(policy, businessEvidence(judged, { meta, google }[o.platform], now, true, matches)).kind;
  };
}

type RuleCutArgs = {
  tenant_id: string;
  judgeInv: Inventory;
  inv: Inventory;
  now: Date;
  pace: SpendPace;
  recentlyOrdered: ReadonlySet<string>;
  dwell: ReadonlySet<string>;
  skip: ReadonlySet<"meta" | "google">;
  saved: import("./business-control-policy").SavedBusinessPolicy | null;
  savedVerdict?: SavedVerdict;
  deps: ControllerDeps;
};

async function ruleCutCandidates(a: RuleCutArgs, makeRoom: boolean): Promise<{ cands: import("./business-rules").CutCandidate[]; step: number; notes: string[] }> {
  const { tenant_id, now, deps } = a;
  const notes: string[] = [];
  const { cutCandidates, budgetHolder, steadySpender, RULE_STEP, CUT_DWELL_DAYS } = await import("./business-rules");
  const { reachOrClickIds } = await import("./business-control-runtime");
  const protectedIds = reachOrClickIds(a.judgeInv.meta.objects);
  for (const o of a.judgeInv.meta.objects) if (o.active && o.parent_active && o.has_live_ads === true && o.audience_ids.length > 0 && o.campaign_id) protectedIds.add(o.campaign_id);
  const all = [...a.judgeInv.meta.objects, ...a.judgeInv.google.objects];
  const yardstick = all.filter((o) => budgetHolder(o) && o.active && o.parent_active && o.brand !== true && o.audience_ids.length === 0 && !protectedIds.has(o.id));
  const cutSkip = await deps.recentOrderKeys(tenant_id, now, CUT_DWELL_DAYS * 24);
  const sv = a.savedVerdict;
  const savedLoser = sv ? (o: AdObject) => (sv(o, "settled") === "loser" && sv(o, "7d") === "loser" ? "its results missed your saved business limit" : null) : undefined;
  const peerOk = sv ? (o: AdObject) => ["winner", "loser"].includes(sv(o, "settled")) : undefined;
  let cands = cutCandidates({
    objects: yardstick.filter((o) => !a.skip.has(o.platform) && !a.dwell.has(dwellKeyOf(o.platform, o.id)) && !metaCannotDeliver(o)),
    yardstick,
    now,
    basisOf: resultBasis,
    protectedIds,
    skip: new Set([...cutSkip].filter((k) => k.startsWith("cut:"))),
    ...(savedLoser ? { savedLoser } : {}),
    ...(peerOk ? { peerOk } : {}),
    ...(makeRoom ? { seasoned: steadySpender } : {}),
  });
  if (!makeRoom && cands.length > 0) {
    const free: typeof cands = [];
    for (const c of cands) {
      const isLocked = deps.cutLocked ? await deps.cutLocked(tenant_id, c.o, now).catch(() => true) : false;
      if (!isLocked) free.push(c);
    }
    if (free.length < cands.length) notes.push(`${cands.length - free.length} clearly worse ad${cands.length - free.length === 1 ? "" : "s"} not cut: still learning or edited recently`);
    cands = free;
  }
  const step = a.saved ? Math.min(a.saved.step_percent / 100, RULE_STEP) : RULE_STEP;
  return { cands, step, notes };
}

export async function founderCutCandidates(tenant_id: string, now: Date = new Date(), deps: ControllerDeps = defaultControllerDeps): Promise<{ cands: import("./business-rules").CutCandidate[]; step: number; incomplete: boolean }> {
  const businessPolicy = deps.businessPolicy ? await deps.businessPolicy(tenant_id) : null;
  const saved = businessPolicy?.enabled ? businessPolicy : null;
  const goal: AdGoalRead = deps.goalMode ? await deps.goalMode(tenant_id).catch((e) => ({ ok: false as const, error: (e as Error).message })) : { ok: true, mode: "native", metric: null };
  if (!goal.ok) throw new Error(`the goal could not be read: ${goal.error}`);
  const unread = (reason: string): Unread => ({ reason, rate_limited: false, ledger_capacity_usd: null });
  const [meta, google] = await Promise.all([
    deps.readMeta(tenant_id, now).catch((e) => ({ connected: true, objects: [], ads: [], unread: unread((e as Error).message) }) as Inventory["meta"]),
    deps.readGoogle(tenant_id).catch((e) => ({ connected: true, objects: [], conversions30d: null, unread: unread((e as Error).message) }) as Inventory["google"]),
  ]);
  const readInv: Inventory = { meta, google };
  const inv = applyGoalBasis(readInv, goal.mode);
  const googleOut = !!inv.google.unread || (goal.mode !== "native" && inv.google.purchases_unread === true);
  const judgeInv: Inventory = googleOut ? { ...inv, google: { ...inv.google, objects: [] } } : inv;
  const skip = new Set<"meta" | "google">([...(inv.meta.unread ? (["meta"] as const) : []), ...(googleOut ? (["google"] as const) : [])]);
  const dwell = new Set([...(await deps.recentOrderKeys(tenant_id, now, DWELL_HOURS))].map((k) => k.replace(/^cut:/, "obj:")));
  {
    const { readExperiments } = await import("./experiment-controls");
    const { settling } = await import("./business-control-runtime");
    const { BUSINESS_CONTROL_DEFAULTS } = await import("./business-control-policy");
    const delay = { reporting_delay_hours: businessPolicy?.reporting_delay_hours ?? BUSINESS_CONTROL_DEFAULTS.reporting_delay_hours };
    const experiments = await readExperiments(tenant_id);
    for (const o of [...inv.meta.objects, ...inv.google.objects]) {
      if (experiments.some((e) => settling(e, delay, now) && e.platform === o.platform && (e.object_id === o.id || e.object_id === o.campaign_id))) dwell.add(dwellKeyOf(o.platform, o.id));
    }
  }
  const savedVerdict = saved ? await savedVerdictOf(tenant_id, saved, goal, now, readInv.meta.objects, deps) : undefined;
  const { cands, step } = await ruleCutCandidates(
    { tenant_id, judgeInv, inv, now, pace: undefined as never, recentlyOrdered: new Set(), dwell, skip, saved, ...(savedVerdict ? { savedVerdict } : {}), deps },
    true,
  );
  return { cands, step, incomplete: skip.size > 0 };
}

async function planRuleCuts(a: RuleCutArgs): Promise<{ orders: PlannedOrder[]; notes: string[] }> {
  const { tenant_id, now, deps } = a;
  const notes: string[] = [];
  try {
    const { cutOrders } = await import("./business-rules");
    const got = await ruleCutCandidates(a, false);
    notes.push(...got.notes);
    const { cands, step } = got;
    if (cands.length === 0) return { orders: [], notes };
    if (a.inv.meta.unread?.ledger_capacity_usd === null || a.inv.google.unread?.ledger_capacity_usd === null) return { orders: [], notes };
    const liveNow = liveCapacityUsd(a.inv, now, a.recentlyOrdered);
    const needed = requiredDailyUsd(a.pace);
    const surplus = round2(liveNow - needed);
    if (surplus <= 0) {
      notes.push("clearly worse ads kept: live budget is not above what the month needs");
      return { orders: [], notes };
    }
    const { orders, tooSmall } = cutOrders(cands, {
      step,
      stops: a.saved?.automatic_stops === true,
      surplus,
      capacityAt: (o, b) => (b <= 0 ? 0 : objectCapacityUsd({ ...o, daily_budget_usd: b }, now, a.recentlyOrdered)),
      required_usd: needed,
      capacity_usd: liveNow,
    });
    for (const c of tooSmall) {
      const name = c.o.name ? `"${c.o.name}"` : c.o.id;
      await deps
        .askFounder?.(tenant_id, `cut_floor:${c.o.platform}:${c.o.id}`, `${name}: ${c.why}. Its budget is too small to cut further, so pause it or fold it into a better ${c.o.level === "campaign" ? "campaign" : "ad set"}?`)
        .catch(() => false);
    }
    if (orders.length) notes.push(`${orders.length} clearly worse ad${orders.length === 1 ? "" : "s"} ${a.saved?.automatic_stops ? "paused" : `cut ${Math.round(step * 100)}%`}`);
    return { orders, notes };
  } catch (e) {
    deps.log(tenant_id, "cgo.spend_controller_cuts_skipped", `no cut this hour: ${(e as Error).message}`);
    return { orders: [], notes };
  }
}

async function planMakeRoom(a: RuleCutArgs): Promise<{ active: boolean; orders: PlannedOrder[]; notes: string[] }> {
  const { tenant_id, now, deps } = a;
  if (!deps.makeRoomNeed) return { active: false, orders: [], notes: [] };
  let need: import("./pending-test-room-cuts").MakeRoomNeed | null;
  try {
    need = await deps.makeRoomNeed(tenant_id, now);
  } catch (e) {
    deps.log(tenant_id, "cgo.spend_controller_make_room_skipped", `no make-room cut this hour: pending tests unreadable: ${(e as Error).message}`);
    return { active: false, orders: [], notes: [] };
  }
  if (!need) return { active: false, orders: [], notes: [] };
  const { shortTests, planMakeRoomCuts, holdKeyOf } = await import("./pending-test-room-cuts");
  const { PENDING_CHANNEL_LABEL } = await import("./pending-tests");
  const shortNow = shortTests({ ...need, inflight_usd: 0 });
  if (shortNow.length === 0) return { active: false, orders: [], notes: [] };
  const labels = [...new Set(shortNow.map((s) => PENDING_CHANNEL_LABEL[s.test.channel]))].join(" and ");
  const logShort = (rows: Array<{ test: { id: string; channel: keyof typeof PENDING_CHANNEL_LABEL }; short_usd: number; why: string }>) => {
    for (const r of rows) {
      deps.log(
        tenant_id,
        "cgo.spend_controller_make_room_short",
        `pending ${PENDING_CHANNEL_LABEL[r.test.channel]} test ${r.test.id} still short $${r.short_usd.toFixed(2)} after this hour's cuts: ${r.why}` +
          ` (left $${need!.left_usd.toFixed(2)}, in flight $${need!.inflight_usd.toFixed(2)} from ${need!.inflight} cut${need!.inflight === 1 ? "" : "s"})`,
      );
    }
  };
  if (shortTests(need).length === 0) {
    const note = `the ${labels} test waits for $${need.inflight_usd.toFixed(2)} from ${need.inflight} make-room cut${need.inflight === 1 ? "" : "s"} already filed`;
    deps.log(tenant_id, "cgo.spend_controller_make_room_inflight", note);
    return { active: true, orders: [], notes: [note] };
  }
  try {
    const { cands, step } = await ruleCutCandidates(a, true);
    const holds = cands.length && deps.objectHolds ? await deps.objectHolds(tenant_id, need.budget_id) : new Map();
    const excluded = new Set<string>();
    const heldWhy = new Map<string, string>();
    const verdicts = new Map<string, boolean>();
    const numbers = { required_usd: requiredDailyUsd(a.pace), capacity_usd: liveCapacityUsd(a.inv, now, a.recentlyOrdered) };
    let plan = planMakeRoomCuts({ need, cands, holds, maxStep: step, excluded, numbers });
    for (let pass = 0; pass <= cands.length; pass++) {
      let refused = false;
      for (const o of plan.orders) {
        const key = `${o.dwell_key}:${String(o.body.daily_budget_usd)}`;
        let ok = verdicts.get(key);
        if (ok === undefined) {
          const v = deps.makeRoomGate ? await deps.makeRoomGate(tenant_id, o, now).catch((e) => ({ ok: false, reasons: [`gate_error:${(e as Error).message.slice(0, 80)}`] })) : { ok: true, reasons: [] };
          ok = v.ok;
          verdicts.set(key, ok);
          if (!ok) heldWhy.set(o.dwell_key, v.reasons.slice(0, 3).join(","));
        }
        if (!ok) {
          const c = plan.cuts.find((x) => `cut:${x.object.platform}:${x.object.id}` === o.dwell_key);
          if (c) excluded.add(holdKeyOf(c.object.platform, c.object.id));
          refused = true;
        }
      }
      if (!refused) break;
      plan = planMakeRoomCuts({ need, cands, holds, maxStep: step, excluded, numbers });
    }
    const notes: string[] = [];
    for (const c of plan.cuts) {
      deps.log(
        tenant_id,
        "cgo.spend_controller_make_room_planned",
        `pending ${PENDING_CHANNEL_LABEL[c.channel]} test ${c.test_id}: cut ${c.object.platform} ${c.object.id} $${c.from_usd.toFixed(2)} -> $${c.to_usd.toFixed(2)} a day, frees about $${c.frees_usd.toFixed(2)}`,
      );
    }
    if (plan.cuts.length) notes.push(`${plan.cuts.length} clearly worse ad${plan.cuts.length === 1 ? "" : "s"} cut to make room for the ${labels} test`);
    const held = [...heldWhy.entries()].map(([k, r]) => `${k} (${r})`);
    logShort(plan.still_short.map((s) => ({ ...s, why: held.length ? `${s.why}; held by the gate: ${held.join("; ")}` : s.why })));
    if (plan.still_short.length) notes.push(`the ${labels} test is still short of room: ${plan.still_short.map((s) => s.why).join("; ")}`);
    return { active: true, orders: plan.orders, notes };
  } catch (e) {
    deps.log(tenant_id, "cgo.spend_controller_make_room_skipped", `no make-room cut this hour: ${(e as Error).message}`);
    return { active: true, orders: [], notes: [] };
  }
}

async function enableSafeDefault(tenant_id: string, objects: AdObject[]): Promise<Set<string>> {
  const { loadPausedByFounder } = await import("./unattended-policy");
  const out = new Set<string>();
  for (const o of objects.filter((x) => x.paused_self && x.daily_budget_usd !== null)) {
    try {
      const owner = await loadPausedByFounder(tenant_id, o.platform, o.id);
      if (owner.pausedByFounder === false) out.add(dwellKeyOf(o.platform, o.id));
    } catch {
    }
  }
  return out;
}

export const defaultControllerDeps: ControllerDeps = {
  businessPolicy: async t => (await import("./business-control-policy")).readBusinessPolicy(t),
  monitorBudgetTests: async (t, now) => (await import("./budget-tests")).monitorBudgetTests(t, now),
  readXCapacity: async (t, now) => (await import("@/services/connectors/x-ads/budget-ledger")).xSpendCapacity(t, now),
  readTiktokCapacity: async (t, now) => (await import("@/services/connectors/tiktok-ads/budget-ledger")).tiktokSpendCapacity(t, now),
  readRedditCapacity: async (t, now) => (await import("@/services/connectors/reddit-ads/budget-ledger")).redditCapacity(t, now),
  cgoAdBudget: async (t, now) => (await import("./cgo-ads")).cgoAdBudget(t, now),
  loadSpendPace: async (t, now) => (await import("@/services/growth/spend-pace")).loadSpendPace(t, now),
  readMeta: (t, now) => metaRead(t, now, () => readMetaInventory(t, now), { allowProbe: true }),
  readGoogle: (t) => readGoogleInventory(t),
  goalMode: async (t) => (await import("./ad-goal-match")).loadAdGoalMode(t),
  recentOrderKeys: readRecentOrderKeys,
  orderBackoffs: readOrderBackoffs,
  rejectedHolds: readRejectedOrderHolds,
  enableSafe: enableSafeDefault,
  cgoPauseHolds: async (t, now) => (await import("./cgo-pause-hold")).loadCgoPauseHolds(t, now),
  copyIds: readCopyIds,
  copyRegions: async (t, i, now) => (await import("./copy-regions")).loadCopyRegions(t, i, now),
  businessShape: async (t) => (await import("./business-shape")).resolveBusinessShape(t),
  businessRulesOff: async () => {
    const { globalClient } = await import("@/services/tenant-client");
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle<{ blob: Record<string, unknown> | null }>();
    if (error) throw new Error(error.message);
    return data?.blob?.spend_controller_business_rules_off === true;
  },
  trackingOk: async (t, p) => (await (await import("./unattended-policy")).loadTracking(t, p)).ok === true,
  cutLocked: async (t, o, now) => {
    const up = await import("./unattended-policy");
    const facts = o.platform === "meta" ? await metaRead(t, now, () => up.loadMetaObjects(t, o.id, o.level === "campaign" ? "campaign" : "adset", now)) : await up.loadGoogleObjects(t, o.id, now);
    return !facts?.length || facts.some((f) => up.locked(f) !== false);
  },
  askFounder: async (t, topic, ask) => (await import("./open-advice")).askFounderOutsideReview({ tenant_id: t, topic, ask }),
  submit: async (input) => (await import("./cgo-ad-orders")).submitCgoAdAction(input),
  wakeCgo: async (t, now) => {
    const { admitBudgetReview } = await import("./budget-review-admission");
    const r = await admitBudgetReview(t, now, { from: "controller" });
    if (r.outcome === "woke") return { woke: true };
    return { woke: false, why: r.outcome === "error" ? `error: ${r.error.slice(0, 200)}` : r.why };
  },
  noteCannotDeliver: async (t, objects, now) => {
    const { alertFounderSafely } = await import("./cgo-blockers");
    if ((await alertFounderSafely(t, "ad set cannot deliver", objects.map((o) => cannotDeliverBlocker(o, now)))) === null) throw new Error("founder alert not sent");
  },
  noteStale: async (t) => {
    const { alertSpendBlind } = await import("./stuck-ad-changes");
    await alertSpendBlind(t);
    const { alertFounderSafely } = await import("./cgo-blockers");
    await alertFounderSafely(t, "spend not readable");
  },
  retarget: (t, now) => ({
    readWebsiteAudience: () => cachedWebsiteAudience(t, now),
    readAdSetSetup: (id) => metaRead(t, now, () => readAdSetSetup(t, id)).catch(() => null),
    readCreativeCopy: (id) => metaRead(t, now, () => readCreativeCopy(t, id)).catch(() => null),
  }),
  creative: (t, now) => ({
    fatiguedAdSets: (ids) => cachedFatiguedAdSets(t, ids, now),
    readCreativeCopy: (id) => metaRead(t, now, () => readCreativeCopy(t, id)).catch(() => null),
    generateImage: (copy) => generateAdImage(t, copy, now).catch(() => null),
    openConflict: async (ad_set_id) => {
      const { findContradictingOpenAdvice, channelsForAdClass, adObjectFor, liveAdNameReader } = await import("./open-advice");
      const payload = { ad_set_id };
      const check = await findContradictingOpenAdvice({
        tenant_id: t,
        channels: channelsForAdClass("meta_ads.create_ad"),
        object: await adObjectFor(t, "meta_ads.create_ad", payload, (cls, p, ids) => metaRead(t, now, () => liveAdNameReader(t)(cls, p, ids))),
        exclude: {},
        exec: { exec_class: "meta_ads.create_ad", exec_payload: payload },
      });
      return check.status !== "clear";
    },
    adReadiness: async () => {
      const { resolveMetaAdCapability } = await import("@/services/tools/meta-ads/write/_library-ad-capability");
      const cap = await metaRead(t, now, () => resolveMetaAdCapability(t));
      await import("./ad-account-watch")
        .then(({ noteMetaReadiness }) => noteMetaReadiness(t, cap.ok ? null : cap.reason_code, now))
        .catch((e) => console.warn(`[ad-spend-controller] readiness note for ${t}: ${(e as Error).message}`));
      return cap.ok ? { ok: true } : { ok: false, code: `meta_ads_${cap.reason_code}` };
    },
  }),
  ledgerCapacity: readLedgerCapacity,
  metaThrottled,
  noteMetaRateLimit,
  maintainHolds: async (t, now) => (await import("@/services/growth/spend-pace")).maintainCgoAdHolds(t, now),
  pendingTestRoom: async (t, now) => (await import("./pending-tests")).loadPendingRoom(t, now),
  makeRoomNeed: async (t, now) => (await import("./pending-test-room-cuts")).loadMakeRoomNeed(t, now),
  objectHolds: async (t, budget_id) => (await import("./pending-test-room-cuts")).readObjectHolds(t, budget_id),
  makeRoomGate: async (t, o, now) => {
    const { authorizeUnattended } = await import("./unattended-policy");
    const { ensureCgoOrderRun, utcHourKey } = await import("./cgo-ad-orders");
    const run_id = await ensureCgoOrderRun(t, o.channel_slug, now);
    const v = await authorizeUnattended(
      t,
      { kind: "ad", exec_class: o.exec_class, payload: o.body, source: { table: "channel_actions", id: `${t}:${o.dwell_key}:${utcHourKey(now)}`, run_id } },
      { now, where: "make_room_preview" },
    );
    return { ok: v.verdict === "allow", reasons: v.reasons };
  },
  log: (tenant_id, code, message) => {
    void import("@/services/logging/logEvent")
      .then(({ logEvent }) => logEvent({ level: "info", source: "ad-spend-controller", code, message: message.slice(0, 500), tenant_id }))
      .catch(() => undefined);
  },
};

export type ControllerOutcome =
  | { tenant_id: string; outcome: "skipped"; why: string }
  | {
      tenant_id: string;
      outcome: "ran";
      required_usd: number;
      capacity_usd: number;
      gap_usd: number;
      ordered: number;
      held: number;
      woke_cgo: boolean;
      data_fresh: boolean;
    }
  | { tenant_id: string; outcome: "error"; error: string };

export async function runSpendControllerForTenant(tenant_id: string, now: Date = new Date(), deps: ControllerDeps = defaultControllerDeps): Promise<ControllerOutcome> {
  try {
    if (deps.monitorBudgetTests) await deps.monitorBudgetTests(tenant_id, now).catch((e) => deps.log(tenant_id, "cgo.budget_test_monitor_failed", (e as Error).message));
    if (!(await deps.cgoAdBudget(tenant_id, now))) return { tenant_id, outcome: "skipped", why: "not_running_ads" };
    const businessPolicy = deps.businessPolicy ? await deps.businessPolicy(tenant_id) : null;
    if (businessPolicy) {
      const { monitorExperiments } = await import("./business-control-runtime");
      await monitorExperiments(tenant_id, now);
    }
    await deps.maintainHolds(tenant_id, now).catch((e) => deps.log(tenant_id, "cgo.spend_controller_holds_failed", (e as Error).message));
    const pace = await deps.loadSpendPace(tenant_id, now);
    if (!pace) {
      deps.log(tenant_id, "cgo.spend_controller_skipped", "no spend pace: the budget could not be read");
      return { tenant_id, outcome: "skipped", why: "no_pace" };
    }
    const goal: AdGoalRead = deps.goalMode ? await deps.goalMode(tenant_id).catch((e) => ({ ok: false as const, error: (e as Error).message })) : { ok: true, mode: "native", metric: null };
    if (!goal.ok) {
      deps.log(tenant_id, "cgo.spend_controller_skipped", `the goal could not be read, so nothing is changed this hour: ${goal.error}`);
      return { tenant_id, outcome: "skipped", why: "goal_unreadable" };
    }
    if (!pace.data_fresh) {
      deps.log(tenant_id, "cgo.spend_controller_stale", businessPolicy?.enabled ? "Spend data is stale: efficiency changes wait; experiment safety stops remain monitored." : "spend data is stale (the hourly spend read has not completed in 3 hours: a connected account cannot be read): nothing is cut or paused; increases only");
      if (deps.noteStale) await deps.noteStale(tenant_id, now).catch((e) => deps.log(tenant_id, "cgo.spend_controller_stale_note_failed", (e as Error).message));
    }

    const unread: Partial<Record<"meta" | "google", Omit<Unread, "ledger_capacity_usd">>> = {};
    const metaHeld = await deps.metaThrottled(tenant_id, now, { allowProbe: true });
    if (metaHeld) unread.meta = { reason: metaHeld, rate_limited: true };
    const [meta, google] = await Promise.all([
      metaHeld
        ? null
        : deps.readMeta(tenant_id, now).catch(async (e) => {
            const rate_limited = isMetaRateLimitError(e);
            if (rate_limited) await deps.noteMetaRateLimit(tenant_id, now);
            unread.meta = { reason: (e as Error).message, rate_limited };
            return null;
          }),
      deps.readGoogle(tenant_id).catch((e) => {
        unread.google = { reason: (e as Error).message, rate_limited: false };
        return null;
      }),
    ]);
    const ledger: Partial<Record<"meta" | "google", number | null>> = {};
    for (const p of ["meta", "google"] as const) {
      const u = unread[p];
      if (!u) continue;
      ledger[p] = await deps.ledgerCapacity(tenant_id, p, now).catch(() => null);
      deps.log(
        tenant_id,
        "cgo.spend_controller_read_failed",
        `${p}${u.rate_limited ? " (rate limited: no Meta reads or changes this hour)" : ""}: ${u.reason}`,
      );
    }
    const reddit = await (deps.readRedditCapacity?.(tenant_id, now) ?? Promise.resolve(undefined));
    const x = await (deps.readXCapacity?.(tenant_id, now) ?? Promise.resolve(undefined));
    const tiktok = await (deps.readTiktokCapacity?.(tenant_id, now) ?? Promise.resolve(undefined));
    const readInv: Inventory = {
      reddit, x, tiktok,
      meta: meta ?? { connected: true, objects: [], ads: [], unread: { ...(unread.meta as Omit<Unread, "ledger_capacity_usd">), ledger_capacity_usd: ledger.meta ?? null } },
      google: google ?? { connected: true, objects: [], conversions30d: null, unread: { ...(unread.google as Omit<Unread, "ledger_capacity_usd">), ledger_capacity_usd: ledger.google ?? null } },
    };
    const inv = applyGoalBasis(readInv, goal.mode);
    const cannotDeliver = cannotDeliverAdSets(inv.meta.objects);
    if (cannotDeliver.length && deps.noteCannotDeliver) {
      await deps.noteCannotDeliver(tenant_id, cannotDeliver, now).catch((e) => deps.log(tenant_id, "cgo.spend_controller_alert_failed", (e as Error).message));
    }
    const googleBlindWhy = goal.mode !== "native" && inv.google.purchases_unread === true ? "its bookings could not be read" : null;
    const googleBlind = googleBlindWhy !== null;
    if (googleBlind) deps.log(tenant_id, "cgo.spend_controller_read_failed", `google: ${googleBlindWhy}; nothing changed on Google this hour`);
    if (inv.google.brand_unread === true)
      deps.log(tenant_id, "cgo.spend_controller_read_failed", `google: its brand campaigns could not be read${inv.google.brand_unread_why ? ` (${inv.google.brand_unread_why})` : ""}; its Search campaigns are left alone this hour`);
    const [ordered24h, recentlyOrdered] = await Promise.all([deps.recentOrderKeys(tenant_id, now, DWELL_HOURS), deps.recentOrderKeys(tenant_id, now, RAMP_HOURS)]);
    const dwell = new Set([...ordered24h].map((k) => k.replace(/^cut:/, "obj:")));
    const backoffs = deps.orderBackoffs
      ? await deps.orderBackoffs(tenant_id, now).catch((e) => {
          deps.log(tenant_id, "cgo.spend_controller_backoff_unread", (e as Error).message);
          return [] as OrderBackoff[];
        })
      : [];
    for (const b of backoffs) {
      dwell.add(b.dwell_key.replace(/^cut:/, "obj:"));
      if (b.fresh) deps.log(tenant_id, "cgo.spend_controller_backoff", `${b.dwell_key}: ${b.why}; not ordered again for ${DWELL_HOURS} hours`);
    }
    const rejectHolds = deps.rejectedHolds
      ? await deps.rejectedHolds(tenant_id, now).catch((e) => {
          deps.log(tenant_id, "cgo.spend_controller_reject_holds_unread", `nothing but cuts this hour: ${(e as Error).message}`);
          return null;
        })
      : [];
    for (const h of rejectHolds ?? []) {
      if (h.fresh) deps.log(tenant_id, "cgo.spend_controller_reject_hold", `${h.dwell_key} (${h.kind}) was rejected${h.note ? `: "${h.note.slice(0, 200)}"` : ""}; not ordered again for ${REJECTED_ORDER_DAYS} days`);
    }
    const rejected = rejectHolds === null ? null : new Set(rejectHolds.map((h) => h.key));
    const { keys: pauseHeld, unread: holdsUnread } = await heldByCgoPause(tenant_id, inv, now, deps);
    const enableSafe = new Set([...(await deps.enableSafe(tenant_id, [...inv.meta.objects, ...inv.google.objects]))].filter((k) => !pauseHeld.has(k)));
    const rulesOff = deps.businessRulesOff ? await deps.businessRulesOff().catch(() => false) : false;
    if (businessPolicy?.enabled) {
      const { readExperiments } = await import("./experiment-controls");
      const { settling } = await import("./business-control-runtime");
      const experiments = await readExperiments(tenant_id).catch(() => null);
      for (const o of [...inv.meta.objects, ...inv.google.objects]) {
        const bound = experiments === null || experiments.some((e) => settling(e, businessPolicy, now) && e.platform === o.platform && (e.object_id === o.id || e.object_id === o.campaign_id));
        if (bound) dwell.add(dwellKeyOf(o.platform, o.id));
      }
    }
    const savedPolicy = businessPolicy?.enabled ? businessPolicy : null;
    const { RULE_STEP } = await import("./business-rules");
    const savedVerdict = savedPolicy ? await savedVerdictOf(tenant_id, savedPolicy, goal, now, readInv.meta.objects, deps) : undefined;
    const savedWinner = savedVerdict ? { canRaise: (o: AdObject) => savedVerdict(o, "7d") === "winner" } : {};
    const raiseRules = !rulesOff
      ? { step: savedPolicy ? Math.min(savedPolicy.step_percent / 100, RULE_STEP) : RULE_STEP, perPlatform: true, ...savedWinner }
      : savedPolicy
        ? { step: Math.min(savedPolicy.step_percent / 100, MAX_RAISE_STEP), perPlatform: false, ...savedWinner }
        : undefined;

    const metaBusy = inv.meta.unread ? null : await deps.metaThrottled(tenant_id, now);
    const frozenWhy: Partial<Record<"meta" | "google", string>> = googleBlindWhy ? { google: googleBlindWhy } : {};
    const copies = deps.copyIds
      ? await deps.copyIds(tenant_id, inv.meta.objects).catch((e) => {
          deps.log(tenant_id, "cgo.spend_controller_copies_unread", `no copy this hour: ${(e as Error).message}`);
          return new Set(inv.meta.objects.map((o) => o.id));
        })
      : undefined;
    const gapInput: Omit<GapPlanInput, "frozen"> = { pace, inv, now, dwell, recentlyOrdered, enableSafe, held: pauseHeld, copies, frozenWhy, ...(rejected ? { rejected } : {}), ...(raiseRules ? { rules: raiseRules } : {}) };
    const frozenWith = (...p: Array<"meta" | "google">) => new Set<"meta" | "google">([...p, ...(googleBlind ? (["google"] as const) : [])]);
    let plan = planGapOrders({ ...gapInput, frozen: frozenWith(...(metaBusy ? (["meta"] as const) : [])) });
    const marketplace = plan.remaining_usd >= 1 && deps.businessShape ? (await deps.businessShape(tenant_id).catch(() => null)) === "marketplace" : false;
    if (!marketplace && plan.remaining_usd >= 1) plan.notes.push("region copies are for marketplaces: none planned");
    if (marketplace && plan.remaining_usd >= 1 && !metaBusy && !inv.meta.unread && !holdsUnread && deps.copyRegions) {
      const goingOn = new Set(
        plan.orders
          .filter((o) => (o.exec_class === "meta_ads.set_status" && o.body.status === "ACTIVE") || (o.exec_class === "google_ads.set_status" && o.body.status === "ENABLED"))
          .map((o) => String(o.body.object_id ?? o.body.campaign_id)),
      );
      const on = (objects: AdObject[]) =>
        objects.map((o) =>
          goingOn.has(o.id) || (o.campaign_id && goingOn.has(o.campaign_id) && !o.paused_self)
            ?
              { ...o, active: true, parent_active: true, paused_self: false, has_live_ads: o.has_live_ads === true || o.has_ready_ads !== false }
            : o,
        );
      const coverageInv: Inventory = goingOn.size ? { ...inv, meta: { ...inv.meta, objects: on(inv.meta.objects) }, google: { ...inv.google, objects: on(inv.google.objects) } } : inv;
      const targets = await deps.copyRegions(tenant_id, coverageInv, now).catch(async (e) => {
        if (isMetaRateLimitError(e)) await deps.noteMetaRateLimit(tenant_id, now).catch(() => undefined);
        deps.log(tenant_id, "cgo.spend_controller_copy_regions_unread", `no copy this hour: ${(e as Error).message}`);
        return null;
      });
      if (targets && targets.regions.length > 0) {
        gapInput.copyRegions = targets.regions;
        gapInput.inv = { ...inv, meta: { ...inv.meta, objects: inv.meta.objects.map((o) => (targets.goals.has(o.id) ? { ...o, goal: targets.goals.get(o.id) } : o)) } };
        plan = planGapOrders({ ...gapInput, frozen: frozenWith() });
      }
    }
    const creative = deps.creative(tenant_id, now);
    let readinessOnce: Promise<{ ok: true } | { ok: false; code: string }> | undefined;
    const adReadiness = creative.adReadiness
      ? () => (readinessOnce ??= creative.adReadiness!().catch(() => ({ ok: false as const, code: "meta_ads_lookup_failed" })))
      : undefined;
    const rt = metaBusy || holdsUnread
      ? { order: null, note: holdsUnread ? "retargeting waits: pause history unreadable" : "retargeting waits: Meta near its rate limit" }
      : await planRetargeting({ pace, inv, now, dwell: new Set([...dwell, ...pauseHeld]), recentlyOrdered, enableSafe, adReadiness }, deps.retarget(tenant_id, now)).catch((e) => ({ order: null, note: `retargeting skipped: ${(e as Error).message}` }));
    const cr = metaBusy || holdsUnread
      ? { orders: [] as PlannedOrder[], notes: [holdsUnread ? "creatives wait: pause history unreadable" : "creatives wait: Meta near its rate limit"] }
      : await planCreatives({ inv, now, dwell, enableSafe, held: pauseHeld }, { ...creative, adReadiness }).catch((e) => ({ orders: [] as PlannedOrder[], notes: [`creatives skipped: ${(e as Error).message}`] }));

    const metaBlocked = inv.meta.unread?.rate_limited ? "rate limited" : await deps.metaThrottled(tenant_id, now);
    for (const o of inv.google.objects) {
      if (o.not_serving) deps.log(tenant_id, "cgo.spend_controller_not_serving", `Google campaign ${o.name ? `"${o.name}"` : o.id} (${o.id}) is on but spent nothing in 7 days: ${o.not_serving}`);
    }
    const notes = [...plan.notes, rt.note, ...cr.notes];
    let planned = [...plan.orders, ...(rt.order ? [rt.order] : []), ...cr.orders];
    if (metaBlocked && !metaBusy && !inv.meta.unread && plan.orders.some((o) => o.channel_slug === "meta_ads")) {
      plan = planGapOrders({ ...gapInput, frozen: frozenWith("meta") });
      notes.splice(0, notes.length, ...plan.notes, rt.note, ...cr.notes);
      planned = [...plan.orders, ...(rt.order ? [rt.order] : []), ...cr.orders];
    }
    let makingRoom = false;
    if (!rulesOff && pace.data_fresh) {
      const judgeInv: Inventory = googleBlind || inv.google.unread ? { ...inv, google: { ...inv.google, objects: [] } } : inv;
      const skip = new Set<"meta" | "google">([...(inv.meta.unread ? (["meta"] as const) : []), ...(googleBlind || inv.google.unread ? (["google"] as const) : [])]);
      const cutArgs: RuleCutArgs = { tenant_id, judgeInv, inv, now, pace, recentlyOrdered, dwell: new Set([...dwell, ...pauseHeld]), skip, saved: savedPolicy, ...(savedVerdict ? { savedVerdict } : {}), deps };
      const room = await planMakeRoom(cutArgs);
      makingRoom = room.active;
      notes.push(...room.notes);
      planned = [...room.orders, ...planned];
      if (!makingRoom && plan.gap_usd < 1) {
        const cuts = await planRuleCuts(cutArgs);
        notes.push(...cuts.notes);
        planned = [...cuts.orders, ...planned];
      }
    }
    if (metaBlocked) {
      const waits = (o: PlannedOrder) => o.channel_slug === "meta_ads" && !isSpendReducingMetaChange(o.exec_class, o.body);
      const dropped = planned.filter(waits).length;
      planned = planned.filter((o) => !waits(o));
      if (dropped > 0) notes.push(`${dropped} Meta order${dropped === 1 ? "" : "s"} skipped: Meta near its rate limit`);
    }
    {
      const r = withoutRejected(planned, rejected);
      planned = r.orders;
      if (r.held.length > 0) notes.push(`${r.held.length} order${r.held.length === 1 ? "" : "s"} held: ${rejected === null ? "rejected orders unreadable" : `the same change was rejected in the last ${REJECTED_ORDER_DAYS} days`}`);
    }

    const createsMetaAd = (c: string) => c === "meta_ads.create_ad" || c === "meta_ads.duplicate_ad_set" || c === "meta_ads.duplicate_campaign";
    if (adReadiness && planned.some((o) => createsMetaAd(o.exec_class))) {
      const r = await adReadiness();
      if (!r.ok) {
        const dropped = planned.filter((o) => createsMetaAd(o.exec_class)).length;
        planned = planned.filter((o) => !createsMetaAd(o.exec_class));
        notes.push(`${dropped} ad-creating Meta order${dropped === 1 ? "" : "s"} held: Meta cannot take a new ad yet (${r.code})`);
      }
    }

    let roomKept = false;
    if (deps.pendingTestRoom) {
      const read = deps.pendingTestRoom;
      const { keepPendingTestRoom } = await import("./pending-tests");
      const kept = await keepPendingTestRoom(planned, () => read(tenant_id, now));
      planned = kept.orders;
      roomKept = kept.kept_room;
      if (kept.note) notes.push(kept.note);
    }

    const { utcHourKey } = await import("./cgo-ad-orders");
    const hour = utcHourKey(now);
    let ordered = 0;
    let held = 0;
    let landedAdds = 0;
    const used = new Set<string>();
    for (const o of planned) {
      if (used.has(o.dwell_key)) continue;
      used.add(o.dwell_key);
      const r = await deps.submit({
        tenant_id,
        channel_slug: o.channel_slug,
        exec_class: o.exec_class,
        body: o.body,
        reason: o.reason,
        idempotency_key: `${tenant_id}:${o.dwell_key}:${hour}`,
        now,
        dwell_key: o.dwell_key,
        ...(o.planner ? { planner: o.planner } : {}),
      });
      const roomFor = o.body[MAKE_ROOM_TEST_KEY];
      if (typeof roomFor === "string") {
        deps.log(
          tenant_id,
          r.ok ? "cgo.spend_controller_make_room_cut" : "cgo.spend_controller_make_room_cut_held",
          `pending test ${roomFor}: ${o.exec_class} ${o.dwell_key} $${Number(o.body.expected_current_daily_budget_usd).toFixed(2)} -> $${Number(o.body.daily_budget_usd).toFixed(2)} a day, frees about $${Number(o.body[MAKE_ROOM_FREES_KEY]).toFixed(2)}${r.ok ? ` (card ${r.action_id})` : `: ${r.why}`}`,
        );
      }
      if (r.ok) {
        ordered += 1;
        landedAdds += o.adds_usd;
      } else {
        held += 1;
        deps.log(tenant_id, "cgo.spend_controller_order_held", `${o.exec_class} ${o.dwell_key}: ${r.why}`);
      }
    }
    let woke = false;
    const open = round2(plan.gap_usd - landedAdds);
    if (!plan.blind && !metaBlocked && !roomKept && rejected !== null && plan.gap_usd >= 1 && open >= Math.max(5, 0.05 * plan.required_usd)) {
      const w = await deps.wakeCgo(tenant_id, now).catch((e) => ({ woke: false, why: (e as Error).message }));
      woke = w.woke;
      if (!w.woke && w.why) notes.push(`cgo not woken: ${w.why}`);
    }
    const unreadNote = unreadPlatforms(inv).length ? ` unread ${unreadPlatforms(inv).join("+")}` : "";
    deps.log(
      tenant_id,
      "cgo.spend_controller_ran",
      `required ${round2(plan.required_usd)} live ${round2(plan.capacity_usd)} gap ${round2(plan.gap_usd)} ordered ${ordered} held ${held}${woke ? " woke cgo" : ""}${unreadNote}; ${notes.filter(Boolean).join("; ")}`,
    );
    return { tenant_id, outcome: "ran", required_usd: plan.required_usd, capacity_usd: plan.capacity_usd, gap_usd: plan.gap_usd, ordered, held, woke_cgo: woke, data_fresh: pace.data_fresh };
  } catch (e) {
    deps.log(tenant_id, "cgo.spend_controller_failed", (e as Error).message);
    return { tenant_id, outcome: "error", error: (e as Error).message };
  }
}
