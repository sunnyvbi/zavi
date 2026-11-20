
import { createHash } from "node:crypto";
import { fbGet, fbPost, getAdAccountCurrency, metaAdsCreds } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertGraphWriteSucceeded, detectCbo, toBudgetMinorUnits } from "./_helpers";
import { minorToMajor } from "./_currency";
import { copyOneAd } from "./launch";
import { nameHasTag, taggedName } from "./_launch-shapers";
import { BID_AMOUNT_STRATEGIES, normalizeMetaTime, type MetaBidStrategy, type AdSetTargetingPatch, type DuplicateAdBody, type UpdateAdBody, type UpdateAdSetBody } from "./_decision-bodies";

function sameAccount(a: unknown, ours: string): boolean {
  return typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");
}

function notOurs(kind: string, id: string): ExpectedToolError {
  return new ExpectedToolError("meta_ads_invalid_target", `${kind} ${id} is not in this workspace's connected ad account; nothing was sent.`);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function targetingFingerprint(targeting: unknown): string {
  return createHash("sha256").update(`meta-targeting:${canonical(targeting ?? {})}`).digest("hex");
}

export function applyTargetingPatch(live: Record<string, unknown>, patch: AdSetTargetingPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...live };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out;
}

export type LiveAdSet = {
  id?: string;
  account_id?: string;
  name?: string;
  end_time?: string | null;
  bid_strategy?: string | null;
  bid_amount?: string | number | null;
  targeting?: Record<string, unknown>;
  campaign?: { daily_budget?: string | null; lifetime_budget?: string | null } | null;
};

export async function readOwnAdSet(tenant_id: string, ad_set_id: string): Promise<LiveAdSet> {
  const [creds, a] = await Promise.all([
    metaAdsCreds(tenant_id),
    fbGet(tenant_id, ad_set_id, {
      fields: "id,account_id,name,end_time,bid_strategy,bid_amount,targeting,campaign{daily_budget,lifetime_budget}",
    }) as Promise<LiveAdSet>,
  ]);
  if (!a?.id || !sameAccount(a.account_id, creds.ad_account_id)) throw notOurs("ad set", ad_set_id);
  return a;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(normalizeMetaTime(a)) === Date.parse(normalizeMetaTime(b));
}

function drift(code: string, what: string, now: unknown, was: unknown): ExpectedToolError {
  return new ExpectedToolError(code, `The ${what} is ${now ?? "none"} now, not ${was ?? "none"} as proposed; nothing was changed.`);
}

export async function metaUpdateAdSet(tenant_id: string, p: UpdateAdSetBody): Promise<{ updated_fields: string[] }> {
  const live = await readOwnAdSet(tenant_id, p.ad_set_id);
  const params: Record<string, string> = {};
  if (p.new_name !== undefined) params.name = p.new_name;

  if (p.end_time !== undefined) {
    if (!sameInstant(live.end_time, p.expected_current_end_time)) {
      throw drift("meta_ads_end_time_drift", "ad set's end date", live.end_time, p.expected_current_end_time);
    }
    if (Date.parse(p.end_time) <= Date.now()) {
      throw new ExpectedToolError("meta_ads_invalid_end_time", "The end date has already passed; nothing was changed.");
    }
    params.end_time = p.end_time;
  }

  if (p.bid_strategy !== undefined) {
    if (live.campaign && detectCbo(live.campaign)) {
      throw new ExpectedToolError(
        "meta_ads_bid_strategy_on_campaign",
        `ad set ${p.ad_set_id}'s campaign holds the budget, so its bid strategy is set on the campaign; nothing was changed.`,
      );
    }
    if ((live.bid_strategy ?? null) !== (p.expected_current_bid_strategy ?? null)) {
      throw drift("meta_ads_bid_strategy_drift", "ad set's bid strategy", live.bid_strategy, p.expected_current_bid_strategy);
    }
    params.bid_strategy = p.bid_strategy;
  }

  if (p.bid_amount_usd !== undefined || p.currency !== undefined) {
    const currency = await getAdAccountCurrency(tenant_id);
    if (p.currency && p.currency.toUpperCase() !== currency.toUpperCase()) {
      throw new ExpectedToolError("meta_ads_currency_mismatch", `The change was proposed in ${p.currency}, but the ad account is in ${currency}; nothing was changed.`);
    }
    if (p.bid_amount_usd !== undefined) {
      const now = live.bid_amount == null ? null : minorToMajor(live.bid_amount, currency);
      const was = p.expected_current_bid_amount_usd ?? null;
      if (Math.round((now ?? 0) * 100) !== Math.round((was ?? 0) * 100)) {
        throw drift("meta_ads_bid_amount_drift", "ad set's bid", now, was);
      }
      params.bid_amount = String(toBudgetMinorUnits(p.bid_amount_usd, currency));
    }
  }

  if (p.bid_strategy !== undefined || p.bid_amount_usd !== undefined) {
    const bidErr = checkUpdatedAdSetBid({
      campaign_budget: !!live.campaign && detectCbo(live.campaign),
      live_strategy: live.bid_strategy ?? null,
      live_has_amount: live.bid_amount != null && live.bid_amount !== "" && Number(live.bid_amount) > 0,
      bid_strategy: p.bid_strategy,
      bid_amount_usd: p.bid_amount_usd,
    });
    if (bidErr) throw new ExpectedToolError("meta_ads_bid_unavailable", `${bidErr}; nothing was changed.`);
  }

  if (p.targeting_patch !== undefined) {
    if (!live.targeting || typeof live.targeting !== "object") {
      throw new ExpectedToolError("meta_ads_targeting_unreadable", "Meta did not return this ad set's targeting, so nothing was changed.");
    }
    if (targetingFingerprint(live.targeting) !== p.expected_targeting_fingerprint) {
      throw new ExpectedToolError(
        "meta_ads_targeting_stale",
        "This ad set's targeting changed after the change was proposed, so nothing was changed. Propose it again from what it targets now.",
      );
    }
    params.targeting = JSON.stringify(applyTargetingPatch(live.targeting, p.targeting_patch));
  }

  if (Object.keys(params).length === 0) {
    throw new ExpectedToolError("meta_ads_invalid_target", "nothing to change on the ad set");
  }
  assertGraphWriteSucceeded(await fbPost(tenant_id, p.ad_set_id, params), "ad set update");
  return { updated_fields: Object.keys(params) };
}

export function checkUpdatedAdSetBid(b: {
  campaign_budget: boolean;
  live_strategy: string | null;
  live_has_amount: boolean;
  bid_strategy?: string;
  bid_amount_usd?: number;
}): string | null {
  if (b.campaign_budget) return null;
  const strategy = b.bid_strategy ?? b.live_strategy;
  const hasAmount = b.bid_amount_usd !== undefined || b.live_has_amount;
  if (b.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS" && b.live_strategy !== "LOWEST_COST_WITH_MIN_ROAS") {
    return "a minimum-ROAS bid needs a ROAS floor, which an ad set update cannot carry yet";
  }
  if (strategy && BID_AMOUNT_STRATEGIES.has(strategy as MetaBidStrategy)) {
    return hasAmount ? null : `the ad set would be on ${strategy} with no bid amount, which Meta refuses; give bid_amount_usd`;
  }
  return null;
}

type LiveAd = { id?: string; account_id?: string; name?: string; status?: string; adset_id?: string; creative?: { id?: string } | null };

async function readOwnAd(tenant_id: string, ad_id: string): Promise<LiveAd> {
  const [creds, a] = await Promise.all([
    metaAdsCreds(tenant_id),
    fbGet(tenant_id, ad_id, { fields: "id,account_id,name,status,adset_id,creative{id}" }) as Promise<LiveAd>,
  ]);
  if (!a?.id || !sameAccount(a.account_id, creds.ad_account_id)) throw notOurs("ad", ad_id);
  return a;
}

export async function metaUpdateAd(tenant_id: string, p: UpdateAdBody): Promise<{ updated_fields: string[]; before_status: string | null }> {
  const live = await readOwnAd(tenant_id, p.ad_id);
  const params: Record<string, string> = {};
  if (p.new_name !== undefined) params.name = p.new_name;
  if (p.creative_id !== undefined) {
    if ((live.creative?.id ?? null) !== (p.expected_current_creative_id ?? null)) {
      throw drift("meta_ads_creative_drift", "ad's creative", live.creative?.id, p.expected_current_creative_id);
    }
    const c = (await fbGet(tenant_id, p.creative_id, { fields: "id,account_id" })) as { id?: string; account_id?: string };
    const creds = await metaAdsCreds(tenant_id);
    if (!c?.id || !sameAccount(c.account_id, creds.ad_account_id)) throw notOurs("creative", p.creative_id);
    params.creative = JSON.stringify({ creative_id: p.creative_id });
  }
  if (p.status !== undefined) params.status = p.status;
  if (Object.keys(params).length === 0) {
    throw new ExpectedToolError("meta_ads_invalid_target", "nothing to change on the ad");
  }
  assertGraphWriteSucceeded(await fbPost(tenant_id, p.ad_id, params), "ad update");
  return { updated_fields: Object.keys(params), before_status: live.status ?? null };
}

export async function metaDuplicateAd(
  tenant_id: string,
  p: DuplicateAdBody & { tag: string },
): Promise<{ id: string; name: string; reused: boolean }> {
  const creds = await metaAdsCreds(tenant_id);
  const src = await readOwnAd(tenant_id, p.source_ad_id);
  await readOwnAdSet(tenant_id, p.ad_set_id);
  const name = taggedName(p.name ?? src.name ?? "Ad", p.tag);

  const siblings = (await fbGet(tenant_id, `${p.ad_set_id}/ads`, { fields: "id,name", limit: 200 })) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  const found = (siblings.data ?? []).find((a) => a.id && nameHasTag(a.name, p.tag));
  let id = found?.id ?? null;
  const reused = !!id;
  if (!id) {
    id = await copyOneAd(tenant_id, creds.ad_account_id, { id: p.source_ad_id, name, status: "ACTIVE" }, p.ad_set_id);
  }
  assertGraphWriteSucceeded(await fbPost(tenant_id, id, { name, status: "ACTIVE" }), "copied ad switch on");
  return { id, name, reused };
}
