
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { cgoChannelRailEmit, resolveChannelExecEmit, type EmitDecisionFn, type ExecEmitCtx } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokCampaignsUrl } from "@/services/connectors/tiktok-ads/composio-read";
import {
  TIKTOK_CREATE_LAUNCH_CLASS,
  TIKTOK_CHAT_EDIT_CLASSES,
  TIKTOK_SET_STATUS_CLASS,
  TIKTOK_UPDATE_BUDGET_CLASS,
  tiktokBudgetBody,
  tiktokStatusBody,
} from "@/services/connectors/tiktok-ads/held-schema";
import { LAUNCH_MEASURED_LINE, tiktokLaunchBody } from "@/services/connectors/tiktok-ads/launch-schema";

import { normalizeTiktokAudience, TIKTOK_AGE_NAMES, TIKTOK_AGE_GROUPS, TIKTOK_GENDER_NAMES } from "@/services/connectors/tiktok-ads/targeting";
import { TIKTOK_UPDATE_SETTINGS_CLASS, tiktokSettingsBody } from "@/services/connectors/tiktok-ads/campaign-settings-schema";

import { advancedGroupLabels, advancedGroupValues, describeDayparting } from "@/services/connectors/tiktok-ads/campaign-advanced";

function settingsDisplay(key: string, value: unknown, locationNames?: Record<string, string>): string {
  if (key === "location_ids" && Array.isArray(value)) {
    return value.map(id => locationNames?.[String(id)] ?? `Unknown location (ID ${String(id)})`).join(", ") || "None";
  }
  return key === "aigc_disclosure_type" ? value === "SELF_DISCLOSURE" ? "Contains AI-generated content" : value === "NOT_DECLARED" ? "Not declared as AI-generated" : "Not set" : key === "dayparting" ? describeDayparting(value) : Array.isArray(value) ? value.join(", ") || (key === "excluded_audience_ids" ? "None" : "All") : value == null ? "Not set" : String(value);
}
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Row = { item: string; before: string; after: string };

export function describeTiktokAction(cls: string, body: unknown): { title: string; sentence: string; rows: Row[]; actionType: "update_ad" | "pause_ad" | "create_ad" } {
  if (cls === TIKTOK_UPDATE_SETTINGS_CLASS) {
    const b = tiktokSettingsBody.parse(body);
    const labels: Record<string, string> = { ...advancedGroupLabels, campaign_name: "Campaign name", adgroup_name: "Ad group name", ad_name: "Ad name", location_ids: "Locations", age_groups: "Ages", gender: "Gender", languages: "Languages", schedule_start_time: "Starts (UTC)", schedule_end_time: "Ends (UTC)", ad_text: "Ad text", landing_page_url: "Destination", call_to_action: "Call to action", video_id: "Video", aigc_disclosure_type: "AI disclosure" };
    const scheduleNote = b.level === "ad_group" && (b.changes.schedule_start_time || b.changes.schedule_end_time) && b.daily_budget_usd != null ? ` Its daily budget is ${usd(b.daily_budget_usd)}. Extending its schedule reserves the remaining daily exposure against your shared ad budget.` : "";
    return { title: `Edit TikTok ${b.level.replace("_", " ")} “${b.name}”`.slice(0, 300), sentence: `Apply the settings you reviewed in TikTok ad account ${b.advertiser_name}.${scheduleNote} TikTok may review creative changes before delivery.`, rows: Object.entries(b.changes).map(([key, value]) => ({ item: labels[key] ?? key, before: settingsDisplay(key, b.before[key], b.location_names), after: settingsDisplay(key, value, b.location_names) })), actionType: "update_ad" };
  }
  if (cls === TIKTOK_CREATE_LAUNCH_CLASS) return describeLaunch(body);
  if (cls === TIKTOK_UPDATE_BUDGET_CLASS) {
    const b = tiktokBudgetBody.parse(body);
    const kind = b.level === "ad_group" ? "ad group" : "campaign";
    const title = `Change the daily budget of the TikTok ${kind} "${b.name}"`.slice(0, 300);
    const sentence = `Zavi changes the daily budget of the ${kind} "${b.name}" in TikTok ad account ${b.advertiser_name} (${b.advertiser_id}) from ${usd(b.expected_current_daily_budget_usd)} to ${usd(b.daily_budget_usd)}.` + (b.expected_current_budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" ? ` This is an average: TikTok may spend up to ${usd(Math.ceil(b.daily_budget_usd * 125) / 100)} on a day; the reservation covers that exposure.` : "");
    return {
      title,
      sentence,
      rows: [
        { item: "Ad account", before: `${b.advertiser_name} (${b.advertiser_id})`, after: `${b.advertiser_name} (${b.advertiser_id})` },
        { item: `${kind[0].toUpperCase()}${kind.slice(1)} "${b.name}"`, before: `${usd(b.expected_current_daily_budget_usd)} a day`, after: `${usd(b.daily_budget_usd)} a day` },
      ],
      actionType: "update_ad",
    };
  }
  if (cls === TIKTOK_SET_STATUS_CLASS) {
    const b = tiktokStatusBody.parse(body);
    const kind = b.level === "ad_group" ? "ad group" : b.level === "ad" ? "ad" : "campaign";
    const pause = b.status === "PAUSED";
    const title = (pause ? `Pause the TikTok ${kind} "${b.name}"` : `Turn the TikTok ${kind} "${b.name}" back on`).slice(0, 300);
    const sentence = pause
      ? `Zavi pauses the ${kind} "${b.name}" in TikTok ad account ${b.advertiser_name} (${b.advertiser_id}). It stops spending until someone turns it back on.`
      : `Zavi turns the ${kind} "${b.name}" back on in TikTok ad account ${b.advertiser_name} (${b.advertiser_id}), covered by ${usd(b.daily_budget_usd ?? 0)} in daily budgets${b.resume_plan ? " on its campaign or ad groups" : ""}.` + (b.resume_plan?.sources.some(s => s.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET") ? " Dynamic daily budgets can spend 25% above their average on a day; the reservation covers that exposure." : "") + " Other paused switches remain paused.";
    return {
      title,
      sentence,
      rows: [
        { item: "Ad account", before: `${b.advertiser_name} (${b.advertiser_id})`, after: `${b.advertiser_name} (${b.advertiser_id})` },
        { item: `${kind[0].toUpperCase()}${kind.slice(1)} "${b.name}"`, before: pause ? "Active" : "Paused", after: pause ? "Paused" : "Active" },
      ],
      actionType: pause ? "pause_ad" : "update_ad",
    };
  }
  throw new ExpectedToolError(
    "channel_action_class_unknown",
    `Zavi does not know where a ${cls} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
  );
}

function describeLaunch(body: unknown): { title: string; sentence: string; rows: Row[]; actionType: "create_ad" } {
  const b = tiktokLaunchBody.parse(body);
  const audience = normalizeTiktokAudience(b);
  const dynamicBudget = b.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
  const runsAs = b.identity.display_name ? `${b.identity.display_name} (TikTok account)` : `TikTok account ${b.identity.identity_id}`;
  const host = new URL(b.landing_url).hostname;
  const title = `Launch a TikTok traffic campaign: "${b.name}"`.slice(0, 300);
  const sentence =
    `Zavi creates one campaign, one ad group and one video ad in TikTok ad account ${b.advertiser_name} (${b.advertiser_id}), all switched off, ` +
    `checks each one, then switches them on with the campaign last. The ad runs as ${runsAs} and sends people to ${host}. ${LAUNCH_MEASURED_LINE}`;
  const none = "Nothing yet";
  const held =
    b.hold_estimate_usd === null
      ? "Nothing: no Zavi ad budget is active; TikTok's budget settings govern delivery"
      : `${usd(b.hold_estimate_usd)} for the rest of this month`;
  const video =
    b.video.source === "zavi"
      ? `Zavi video, ${b.video.width}x${b.video.height}, ${Math.round(b.video.duration_s)}s`
      : b.video.source === "upload"
        ? `The video you uploaded, ${b.video.width}x${b.video.height}, ${Math.round(b.video.duration_s)}s`
        : b.video.source === "library"
          ? `Ad account library video ${b.video.video_id}, ${b.video.width}x${b.video.height}, ${Math.round(b.video.duration_s)}s`
          : `Your video from ${b.video.link_host ?? "a link"}, ${b.video.width}x${b.video.height}, ${Math.round(b.video.duration_s)}s`;
  return {
    title,
    sentence,
    rows: [
      { item: "Ad account", before: `${b.advertiser_name} (${b.advertiser_id})`, after: `${b.advertiser_name} (${b.advertiser_id})` },
      { item: "Campaign type", before: none, after: "Traffic: clicks to your site" },
      ...Object.entries(advancedGroupValues(b)).map(([key, value]) => ({ item: advancedGroupLabels[key] ?? key, before: none, after: settingsDisplay(key, value) })),
      { item: dynamicBudget ? "Average daily budget" : "Daily budget", before: none, after: dynamicBudget
        ? `${usd(b.daily_budget_usd)} average per day on the ad group. TikTok may spend up to ${usd(Math.ceil(b.daily_budget_usd * 125) / 100)} on a day; an unchanged full calendar week is limited to 7 times the average. Midweek changes alter the allowance. The reservation covers the daily maximum.`
        : `${usd(b.daily_budget_usd)} a day, on the ad group (the campaign has no limit of its own)` },
      { item: "Held from your ad budget", before: none, after: held },
      { item: "Where", before: none, after: b.locations.map((l) => l.name).join(", ") },
      { item: "Ages", before: none, after: audience.age_groups.length === TIKTOK_AGE_GROUPS.length ? "All adult ages" : audience.age_groups.map((a) => TIKTOK_AGE_NAMES[a]).join(", ") },
      { item: "Gender", before: none, after: TIKTOK_GENDER_NAMES[audience.gender] },
      { item: "Languages", before: none, after: audience.languages.length ? (b.language_names?.length === audience.languages.length ? b.language_names : audience.languages).join(", ") : "All languages" },
      { item: "Starts", before: none, after: `${b.start_time.slice(0, 16).replace("T", " ")} UTC, or at least 5 minutes after approval if that is later` },
      { item: "Video", before: none, after: video },
      { item: "Ad text", before: none, after: b.ad_text },
      { item: "Call to action", before: none, after: b.call_to_action.replace(/_/g, " ").toLowerCase() },
      { item: "Landing page", before: none, after: `${b.landing_url} (Zavi adds its launch tag; your own tracking tags are kept)` },
      { item: "Runs as", before: none, after: runsAs },
      { item: "Measured", before: none, after: "Clicks and site visits (not sales)" },
    ],
    actionType: "create_ad",
  };
}

export async function resolveTiktokAdsEmit(ctx: ExecEmitCtx, opts: { chatEdit?: boolean } = {}): Promise<EmitDecisionFn | undefined> {
  const emit = await resolveChannelExecEmit(new Set(["tiktok_ads"]), ctx, async (a) => {
    const { title, sentence, rows, actionType } = describeTiktokAction(a.decision_class, a.body);
    const rationale = String((a.body as { rationale?: unknown }).rationale ?? "").trim();
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      actionType,
      title,
      body: {
        step: { title, body: [sentence, rationale].filter(Boolean).join("\n\n"), blocking: false, effort: "minutes", evidence: [] },
        change_sentence: sentence,
        exact_change: { rows },
        decision_evidence: null,
        link: tiktokCampaignsUrl(String((a.body as { advertiser_id?: unknown }).advertiser_id ?? "")),
      },
    });
    return id;
  });
  if (emit !== ctx.emit_decision || !emit) return emit;
  if (!opts.chatEdit) return cgoChannelRailEmit(ctx, "tiktok_ads", (c) => resolveTiktokAdsEmit(c));
  return async (decision_class, body) => {
    if (!TIKTOK_CHAT_EDIT_CLASSES.has(decision_class)) {
      throw new ExpectedToolError("tiktok_ads_launch_channel_only", "A new TikTok campaign is proposed on the TikTok Ads channel, not in chat. Nothing was proposed.");
    }
    return emit(decision_class, { ...(body as Record<string, unknown>), origin: "user_initiated_chat" });
  };
}
