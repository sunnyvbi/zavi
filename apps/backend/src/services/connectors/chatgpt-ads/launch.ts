import { adsFx } from "@/services/ads-wallet/fx";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LaunchItem, LaunchResult, LaunchSummary } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { fundingLimit } from "./campaign-settings";
import { readCampaign, readCampaignTree, readServerMadeTree, serverMadeDrift, updateAdStatus, updateCampaign, updateGroupStatus, SERVER_MADE, type ServerMadeManifest } from "./workspace";

type Row = Record<string, any>;
const fail = (message: string): never => { throw new ExpectedToolError("chatgpt_ads_conflict", message); };

const NOT_SERVABLE_REVIEW = /reject|disapprov|denied/i;

export const launchInput = z.object({ expected_updated_at: z.number().int(), snapshot: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export function launchSnapshot(tree: { campaign: Row; groups: Row[]; ads: Row[] }): string {
  const c = tree.campaign;
  const byId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id));
  const material = {
    campaign: { id: c.id, updated_at: c.updated_at, status: c.status ?? null, budget: c.budget ?? null, targeting: c.targeting ?? null, start_time: c.start_time ?? null, end_time: c.end_time ?? null, bidding_type: c.bidding_type ?? null, conversion_event_setting_ids: c.conversion_event_setting_ids ?? [], mode: c.mode ?? null, product_feed_id: c.product_feed_id ?? null, landing_page_configuration: c.landing_page_configuration ?? null },
    groups: [...tree.groups].sort(byId).map(g => ({ id: g.id, status: g.status ?? null, bidding_config: g.bidding_config ?? null, context_hints: g.context_hints ?? null, landing_page_configuration: g.landing_page_configuration ?? null })),
    ads: [...tree.ads].sort(byId).map(a => ({ id: a.id, ad_group_id: a.ad_group_id, status: a.status ?? null, servable: servable(a), landing_page_configuration: a.landing_page_configuration ?? null, creative: a.creative ? { type: a.creative.type ?? null, title: a.creative.title ?? null, body: a.creative.body ?? null, target_url: a.creative.target_url ?? null, file_id: a.creative.file_id ?? null } : null })),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

const servable = (ad: Row) => !NOT_SERVABLE_REVIEW.test(String(ad.review_status ?? ""));

const epochSec = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const scheduleEnded = (c: Row): boolean => { const end = epochSec(c.end_time); return end != null && end * 1000 <= Date.now(); };

function launchState(tree: { campaign: Row; groups: Row[]; ads: Row[] }): LaunchSummary["state"] {
  if (tree.campaign.status === "archived") return "archived";
  if (scheduleEnded(tree.campaign)) return "ended";
  const live = tree.groups.length > 0 && tree.ads.some(servable) && tree.campaign.status === "active"
    && tree.groups.every(g => g.status === "active")
    && tree.ads.filter(servable).every(a => a.status === "active");
  return live ? "launched" : "ready";
}

async function campaignFunding(tenantId: string, campaignId: string) {
  const res = await tenantClient(asTenantId(tenantId)).from("ads_campaign_funding").select("reserved_cents, spent_cents, daily_max_micros, coverage_start, coverage_end").eq("campaign_id", campaignId).maybeSingle();
  if (res.error) throw new Error("Ads funding storage is unavailable");
  const data = res.data as { reserved_cents: unknown; spent_cents: unknown; daily_max_micros: unknown; coverage_start: unknown; coverage_end: unknown } | null;
  const amount = (v: unknown): number => {
    if (typeof v !== "number" && !(typeof v === "string" && /^\d+$/.test(v))) throw new Error("Unreadable campaign funding");
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Unreadable campaign funding");
    return n;
  };
  return {
    reserved: data ? amount(data.reserved_cents) : 0,
    spent: data ? amount(data.spent_cents) : 0,
    daily: data?.daily_max_micros == null ? null : amount(data.daily_max_micros),
    start: data?.coverage_start == null ? null : amount(data.coverage_start),
    end: data?.coverage_end == null ? null : amount(data.coverage_end),
  };
}

export async function campaignWalletReserved(tenantId: string, campaignId: string): Promise<boolean | null> {
  try { return (await campaignFunding(tenantId, campaignId)).reserved > 0; } catch { return null; }
}

export async function readLaunchSummary(tenantId: string, campaignId: string): Promise<LaunchSummary> {
  const tree = await readCampaignTree(tenantId, campaignId);
  const currency = tree.providerCurrency ?? "USD";
  const fx = await adsFx(currency);
  const c = tree.campaign;
  const lifetime = typeof c.budget?.lifetime_spend_limit_micros === "number" ? c.budget.lifetime_spend_limit_micros as number : null;
  const daily = typeof c.budget?.daily_spend_limit_micros === "number" ? c.budget.daily_spend_limit_micros as number : null;
  let wallet: LaunchSummary["wallet"] = null;
  let shortfall: number | null = null;
  try {
    if(tree.binding?.funding_source==="provider") { shortfall=0; }
    else {
    const { readWallet } = await import("@/services/channels/chatgpt-ads/wallet");
    const w = await readWallet(tenantId);
    wallet = { currency: w.currency, available_cents: w.available_cents, funding_enabled: w.funding_enabled, in_app_enabled: w.in_app_enabled };
    const f = await campaignFunding(tenantId, campaignId);
    const covered = daily == null ? c : {
      ...c,
      budget: { ...c.budget, daily_spend_limit_micros: Math.max(daily, f.daily ?? daily) },
      start_time: Math.min(c.start_time ?? Infinity, c.created_at ?? Infinity, f.start ?? Infinity),
      end_time: Math.max(c.end_time ?? -Infinity, f.end ?? -Infinity),
    };
    const limit = fundingLimit(covered);
    if (!Number.isSafeInteger(w.available_cents) || w.currency !== "USD") throw new Error("Unreadable wallet coverage");
    const need = Math.max(0, Math.ceil(limit / 10_000) - f.spent - f.reserved);
    shortfall = Math.max(0, need - w.available_cents);
    }
  } catch {  }
  return {
    state: launchState(tree),
    campaign: {
      id: c.id, name: String(c.name ?? ""), status: c.status ?? null, updated_at: c.updated_at, bidding_type: String(c.bidding_type ?? ""),
      lifetime_budget_micros: lifetime, daily_budget_micros: daily,
      countries: Array.isArray(c.targeting?.locations?.countries) ? c.targeting.locations.countries.filter((v: unknown) => typeof v === "string") : [],
      targeting: c.targeting,
      start_time: epochSec(c.start_time), end_time: epochSec(c.end_time),
    },
    groups: tree.groups.map(g => ({ id: g.id, name: String(g.name ?? "Ad group"), status: g.status ?? null, max_bid_micros: typeof g.bidding_config?.max_bid_micros === "number" ? g.bidding_config.max_bid_micros : null })),
    ads: tree.ads.map(a => ({
      id: a.id, ad_group_id: a.ad_group_id, name: String(a.name ?? "Ad"), status: a.status ?? null,
      review_status: typeof a.review_status === "string" ? a.review_status : null,
      title: typeof a.creative?.title === "string" ? a.creative.title : null,
      body: typeof a.creative?.body === "string" ? a.creative.body : null,
      target_url: typeof a.creative?.target_url === "string" ? a.creative.target_url : null,
    })),
    wallet,
    funding_source: tree.binding?.funding_source ?? "wallet",
    provider_account_id:tree.providerAccountId??null,
    shortfall_cents: shortfall,
    currency, fx,
    snapshot: launchSnapshot(tree),
  };
}

const reasonOf = (e: unknown) => e instanceof ExpectedToolError ? e.message : "The platform did not confirm this change.";

export async function launchCampaign(tenantId: string, campaignId: string, input: unknown, beforeActivate?: () => Promise<void>): Promise<LaunchResult> {
  const { expected_updated_at, snapshot } = launchInput.parse(input);
  return launch(tenantId, campaignId, { expected_updated_at, snapshot }, beforeActivate);
}

export const launchTiming = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) };
export const SERVER_MADE_WAIT_MS = 45_000;
export const READBACK_WAIT_MS = 20_000;

const transient = (e: unknown) => {
  const status = e instanceof ExpectedToolError ? (e.meta as { status?: number } | undefined)?.status : undefined;
  return typeof status === "number" && (status === 429 || status >= 500);
};

export async function untilSettled<T>(read: () => Promise<T>, done: (v: T) => boolean, deadline: number): Promise<{ value: T; settled: boolean }> {
  let wait = 1000;
  let last: { value: T } | null = null;
  for (;;) {
    try {
      const value = await read();
      if (done(value)) return { value, settled: true };
      last = { value };
    } catch (e) {
      if (!transient(e) || launchTiming.now() >= deadline) throw e;
    }
    const left = deadline - launchTiming.now();
    if (left > 0) await launchTiming.sleep(Math.min(wait, left));
    wait = Math.min(wait * 2, 5000);
    if (launchTiming.now() >= deadline) {
      if (last) return { value: last.value, settled: false };
      throw new ExpectedToolError("chatgpt_ads_unavailable", "ChatGPT Ads did not answer in time.");
    }
  }
}

export async function launchServerMadeCampaign(tenantId: string, campaignId: string, manifest: ServerMadeManifest, beforeActivate?: () => Promise<void>): Promise<LaunchResult> {
  const deadline = launchTiming.now() + SERVER_MADE_WAIT_MS;
  const rejected = (t: { ads: Row[] }) => t.ads.find(a => !servable(a));
  const { value: tree, settled } = await untilSettled(() => readServerMadeTree(tenantId, campaignId, manifest), t => t.missing.length === 0 || !!rejected(t) || t.archived.length > 0, deadline);
  if (tree.archived.length > 0) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: "child_archived" } });
    return fail("The ad group or ad Zavi just made was archived before launch, so the campaign was not turned on.");
  }
  if (rejected(tree)) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: "ad_rejected_in_review" } });
    return fail("ChatGPT rejected the ad in its review, so the campaign was not turned on.");
  }
  if (!settled) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: "children_not_visible", missing: tree.missing.length, groups: tree.groups.length, ads: tree.ads.length } });
    return fail(`ChatGPT did not show the ad group and ad Zavi just made within ${SERVER_MADE_WAIT_MS / 1000} seconds, so the campaign was not turned on.`);
  }
  const drift = await serverMadeDrift(tenantId, campaignId, manifest, tree);
  if (drift) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: "changed_since_made" } });
    return fail(drift);
  }
  return launch(tenantId, campaignId, null, beforeActivate, tree);
}

async function launch(tenantId: string, campaignId: string, confirmed: { expected_updated_at: number; snapshot: string } | null, beforeActivate?: () => Promise<void>, serverMade?: Awaited<ReturnType<typeof readServerMadeTree>>): Promise<LaunchResult> {
  const tree = serverMade ?? await readCampaignTree(tenantId, campaignId);
  const c = tree.campaign;
  if (c.status === "archived") return fail("This campaign was archived. Create a new one to launch.");
  if (scheduleEnded(c)) return fail("This campaign's schedule already ended, so turning it on would not make it deliver. Extend its end date in campaign settings, or create a new campaign.");
  if (confirmed && (c.updated_at !== confirmed.expected_updated_at || launchSnapshot(tree) !== confirmed.snapshot)) return fail("This campaign changed since you opened it. Review it again before launching.");
  const expected_updated_at: number = confirmed?.expected_updated_at ?? c.updated_at;
  if (!tree.groups.length || !tree.ads.some(servable)) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: "no_eligible_ads", groups: tree.groups.length, ads: tree.ads.length, servable: tree.ads.filter(servable).length } });
    return fail("This campaign has no ads eligible for launch. Add an ad or resolve its review before launching.");
  }
  const items: LaunchItem[] = [];
  const stop = (e: unknown, item: Omit<LaunchItem, "status" | "reason">): LaunchResult => {
    items.push({ ...item, status: "failed", reason: reasonOf(e) });
    const code = e instanceof ExpectedToolError ? e.code : "chatgpt_ads_unavailable";
    const activated = items.filter(i => i.status === "activated").length;
    void logEvent({ level: activated ? "error" : "warn", source: "chatgpt-ads", code: activated ? "chatgpt_ads.launch_partial" : "chatgpt_ads.launch_refused", tenant_id: tenantId, meta: { failure_class: code } });
    return { ok: false, items, code, message: activated ? "Part of the campaign is on. Nothing ran twice. Finish the launch when you are ready." : reasonOf(e) };
  };

  let version: number = c.updated_at;
  const childVersion = () => (confirmed ? version : SERVER_MADE);
  if (c.status === "active") items.push({ kind: "campaign", id: c.id, name: String(c.name), status: "already_active" });
  else {
    try {
      await beforeActivate?.();
      await updateCampaign(tenantId, campaignId, { status: "active", ...(confirmed ? { expected_updated_at } : {}) });
      items.push({ kind: "campaign", id: c.id, name: String(c.name), status: "activated" });
    } catch (e) { return stop(e, { kind: "campaign", id: c.id, name: String(c.name) }); }
    try {
      const { value: fresh } = await untilSettled(() => readCampaign(tenantId, campaignId), f => f.status === "active", launchTiming.now() + READBACK_WAIT_MS);
      if (typeof fresh.updated_at !== "number" || fresh.status !== "active") throw new ExpectedToolError("chatgpt_ads_bad_response", "The campaign could not be confirmed active on readback.");
      version = fresh.updated_at;
    }
    catch (e) {
      const code = e instanceof ExpectedToolError ? e.code : "chatgpt_ads_unavailable";
      void logEvent({ level: "error", source: "chatgpt-ads", code: "chatgpt_ads.launch_partial", tenant_id: tenantId, meta: { failure_class: code } });
      return { ok: false, items, code, message: "The campaign is on, but Zavi could not read it back to turn on its ads. Nothing ran twice. Finish the launch when you are ready." };
    }
  }
  for (const g of tree.groups) {
    const item = { kind: "ad_group" as const, id: g.id, name: String(g.name ?? "Ad group") };
    if (g.status === "active") { items.push({ ...item, status: "already_active" }); continue; }
    try { await beforeActivate?.(); await updateGroupStatus(tenantId, campaignId, g.id, "active", childVersion()); items.push({ ...item, status: "activated" }); }
    catch (e) { return stop(e, item); }
  }
  for (const a of tree.ads) {
    const item = { kind: "ad" as const, id: a.id, name: String(a.creative?.title ?? a.name ?? "Ad") };
    if (!servable(a)) { items.push({ ...item, status: "skipped", reason: "Not approved in the platform's review." }); continue; }
    if (a.status === "active") { items.push({ ...item, status: "already_active" }); continue; }
    try { await beforeActivate?.(); await updateAdStatus(tenantId, campaignId, a.ad_group_id, a.id, "active", childVersion()); items.push({ ...item, status: "activated" }); }
    catch (e) { return stop(e, item); }
  }
  void logEvent({ level: "info", source: "chatgpt-ads", code: "chatgpt_ads.campaign_launched", tenant_id: tenantId, message: `Launched: ${items.filter(i => i.status === "activated").length} activated, ${items.filter(i => i.status === "skipped").length} skipped.` });
  return { ok: true, items };
}

export function awaitingReview(tree: { ads: Row[] }): boolean {
  return tree.ads.some(a => !NOT_SERVABLE_REVIEW.test(String(a.review_status ?? "")) && /pending|review|submitted|processing/i.test(String(a.review_status ?? "")) && !/approved/i.test(String(a.review_status ?? "")));
}

export function fullyActive(tree: Awaited<ReturnType<typeof readCampaignTree>>) {
  const ads = tree.ads.filter(a => !/reject|disapprov|denied/i.test(String(a.review_status ?? "")));
  return tree.campaign.status === "active" && tree.groups.length > 0 && tree.groups.every(g => g.status === "active") && ads.length > 0 && ads.every(a => a.status === "active");
}
