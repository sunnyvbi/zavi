import { ExpectedToolError } from "@/services/tools/types";
import { ownedAccount, pages, endpoint, payload, record, tool, type RedditAccount } from "./adapter";

export const CONVERSION_EVENTS = ["SIGN_UP", "LEAD", "PURCHASE"] as const;
export type ConversionEvent = (typeof CONVERSION_EVENTS)[number];
export const TRACKING_FRESH_MS = 7 * 86_400_000;

export const REDDIT_CAPI_SETUP = {
  state: "setup_required",
  automatic_optimization_ready: false,
  reason: "The Ads OAuth connection alone does not verify adsconversions or Events Manager CAPI token access. No website events are sent by this connector until credentials and consent are configured.",
} as const;

export function eventFresh(last: unknown, now = new Date()): boolean {
  if (typeof last !== "string") return false;
  const age = now.getTime() - Date.parse(last);
  return Number.isFinite(age) && age >= 0 && age <= TRACKING_FRESH_MS;
}

export async function tracking(account: RedditAccount, accountId: string, pixelId: string, event?: string, now = new Date()) {
  const pixels = await pages(account, "LIST_PIXELS_BY_AD_ACCOUNT", { ad_account_id: accountId }, endpoint("ad_accounts", accountId, "/pixels"));
  if (!pixels.some((p) => p.id === pixelId)) throw new ExpectedToolError("reddit_ads_pixel_not_owned", "Select a pixel accessible to the selected ad account.");
  const fired = payload(await tool(account, "GET_PIXEL_LAST_FIRED_AT", { pixel_id: pixelId }));
  if (!record(fired)) throw new ExpectedToolError("reddit_ads_tracking_unverified", "Reddit did not return pixel activity.");
  const last = event ? fired[event.toLowerCase()] : null;
  return {
    pixel_id: pixelId,
    event: event ?? null,
    last_fired_at: typeof last === "string" ? last : null,
    event_fresh: event ? eventFresh(last, now) : null,
    events: fired,
  };
}

type TrackingSignal = Awaited<ReturnType<typeof tracking>> | null;

export function accountApproved(details: Record<string, unknown>): boolean {
  return details.admin_approval === "VALID" && !details.suspension_reason;
}

function readinessFailure(details: Record<string, unknown>, trackingFailure: string | null, signal: TrackingSignal, event?: string): string | null {
  if (typeof details.time_zone_id !== "string") return "Reddit did not return the account timezone; dated reads cannot be windowed.";
  if (details.currency !== "USD") return `This account bills in ${String(details.currency)}; Zavi supports USD Reddit accounts only.`;
  if (!accountApproved(details)) return "Resolve account approval or suspension in Reddit Ads Manager.";
  if (trackingFailure) return trackingFailure;
  if (event && signal?.event_fresh !== true) return `The ${event} event has not fired in the last seven days. Fix tracking before judging conversions.`;
  return null;
}

export async function readiness(tenantId: string, accountId: string, pixelId?: string, event?: string) {
  const { account, details } = await ownedAccount(tenantId, accountId);
  const profiles = await pages(account, "LIST_PROFILES_BY_AD_ACCOUNT", { ad_account_id: accountId }, endpoint("ad_accounts", accountId, "/profiles"));
  const pixels = await pages(account, "LIST_PIXELS_BY_AD_ACCOUNT", { ad_account_id: accountId }, endpoint("ad_accounts", accountId, "/pixels"));
  let signal: TrackingSignal = null;
  let trackingFailure: string | null = null;
  if (pixelId) {
    try {
      signal = await tracking(account, accountId, pixelId, event);
    } catch (e) {
      trackingFailure = e instanceof Error ? e.message : "Tracking could not be checked";
    }
  }
  const failure = readinessFailure(details, trackingFailure, signal, event);
  return {
    ad_account_id: accountId,
    connection: "owned_active",
    read_access: "verified",
    write_access: "unverified",
    conversion_access: "unverified",
    currency: details.currency ?? null,
    supported_currency: details.currency === "USD",
    time_zone: typeof details.time_zone_id === "string" ? details.time_zone_id : null,
    account_ready: accountApproved(details),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    pixels: pixels.map((p) => ({ id: p.id, name: p.name })),
    tracking: signal,
    execution_state: "read_only",
    delivery_state: "not_checked",
    failure_reason: failure,
    next_recovery_step: failure ?? (pixelId ? "Reads are verified. Write permission has not been checked; this connector has not changed the account." : "Select an account pixel to check its goal event tracking."),
    capi: REDDIT_CAPI_SETUP,
  };
}
