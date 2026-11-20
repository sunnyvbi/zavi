
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { cgoChannelRailEmit, resolveChannelExecEmit, type EmitDecisionFn, type ExecEmitCtx } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { redditCampaignsUrl } from "@/services/connectors/reddit-ads/composio-read";
import { permanentReadRefusal } from "@/services/connectors/reddit-ads/read-refusal";
export { permanentReadRefusal };
import { REDDIT_ACTION_SCHEMAS, type RedditActionClass } from "@/services/connectors/reddit-ads/schema";

export const REDDIT_SET_STATUS_CLASS = "reddit_ads.set_status";
const SWITCHED_REDDIT_CHANNELS: ReadonlySet<string> = new Set(["reddit_ads"]);

export type RedditStatusBody = {
  campaign_id: string;
  ad_account_id: string;
  status: "PAUSED";
  name: string;
  rationale: string;
};

export function buildRedditExecCardBody(body: RedditStatusBody): { title: string; card: Record<string, unknown> } {
  const title = `Pause the Reddit campaign "${body.name}"`.slice(0, 300);
  const sentence = `Zavi pauses "${body.name}" in Reddit Ads. It stops spending until someone turns it back on.`;
  return {
    title,
    card: {
      step: {
        title,
        body: [sentence, body.rationale.trim()].filter(Boolean).join("\n\n"),
        blocking: false,
        effort: "minutes",
        evidence: [],
      },
      change_sentence: sentence,
      exact_change: { rows: [{ item: `Campaign "${body.name}"`, before: "Active", after: "Paused" }] },
      decision_evidence: null,
      link: redditCampaignsUrl(body.ad_account_id),
    },
  };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Row = { item: string; before: string; after: string };

export type RedditLiveObject = { id: string; name?: string | null; configured_status?: string | null; targeting?: unknown; click_url?: unknown };

const untag = (n: string) => n.replace(/\s*\[prax:[^\]]*\]\s*$/, "").trim();
const listed = (v: unknown, empty: string) => (Array.isArray(v) && v.length ? v.map(String).join(", ") : empty);
const statusWord = (s: string | null | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "unread");

function liveTarget(cls: RedditActionClass, body: Record<string, unknown>): { level: "campaign" | "ad_group" | "ad"; id: string } | null {
  if (cls === "reddit_ads.update_budget" || cls === "reddit_ads.update_targeting" || cls === "reddit_ads.replace_creative") return { level: "ad_group", id: String(body.ad_group_id) };
  if (cls === "reddit_ads.update_ad") return { level: "ad", id: String(body.ad_id) };
  if (cls === "reddit_ads.set_object_status" || cls === "reddit_ads.rename_object" || cls === "reddit_ads.remove_object") return { level: body.level as "campaign" | "ad_group" | "ad", id: String(body.object_id) };
  return null;
}

export type RedditLiveRead = { live: RedditLiveObject | null; refusal: string | null };

export async function readRedditLiveResult(tenantId: string, cls: RedditActionClass, body: Record<string, unknown>): Promise<RedditLiveRead> {
  const target = liveTarget(cls, body);
  if (!target) return { live: null, refusal: null };
  try {
    const { ownedAccount, getObject } = await import("@/services/connectors/reddit-ads/adapter");
    const { account } = await ownedAccount(tenantId, String(body.ad_account_id));
    return { live: await getObject(account, String(body.ad_account_id), target.level, target.id), refusal: null };
  } catch (e) {
    return { live: null, refusal: permanentReadRefusal(e) };
  }
}

export function describeRedditAction(cls: RedditActionClass, body: Record<string, unknown>, live: RedditLiveObject | null = null): { title: string; sentence: string; rows: Row[] } {
  const name = live?.name ? untag(live.name) : String(body.name);
  const ref = live ? ` (${live.id})` : "";
  const was = (key: string, empty: string) =>
    live?.targeting && typeof live.targeting === "object" ? listed((live.targeting as Record<string, unknown>)[key], empty) : "not read";
  if (cls === "reddit_ads.prepare_campaign") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const title = `Create the paused Reddit campaign "${name}"`.slice(0, 300);
    const sentence = `Zavi creates "${name}" in Reddit Ads with ${b.creatives.length} image ad${b.creatives.length === 1 ? "" : "s"}, everything paused. Nothing spends until a separate launch is approved.`;
    return { title, sentence, rows: [
      { item: "Daily budget", before: "none", after: `${usd(b.daily_budget_usd)} a day` },
      { item: "Lifetime cap", before: "none", after: usd(b.lifetime_cap_usd) },
      { item: "Ad group start", before: "none", after: b.start_time },
      { item: "Objective", before: "none", after: "Traffic (clicks)" },
      { item: "Countries or regions", before: "none", after: b.targeting.geolocations.join(", ") },
      ...(b.targeting.excluded_geolocations ? [{ item: "Excluded countries or regions", before: "none", after: b.targeting.excluded_geolocations.join(", ") }] : []),
      { item: "Communities", before: "none", after: b.targeting.communities.length ? b.targeting.communities.join(", ") : "all" },
      ...b.creatives.flatMap((c, i) => (c.click_url && c.click_url !== c.destination_url ? [{ item: `Ad ${i + 1} "${c.name}" click link (tracking)`, before: "none", after: c.click_url }] : [])),
      { item: "Status", before: "none", after: "Paused" },
    ] };
  }
  if (cls === "reddit_ads.launch_campaign") {
    const title = `Turn on the prepared Reddit campaign "${name}"`.slice(0, 300);
    const sentence = `Zavi turns on "${name}" in Reddit Ads. Spending starts at its approved daily budget once Reddit approves the ads.`;
    return { title, sentence, rows: [{ item: `Campaign "${name}"`, before: "Paused", after: "Active" }] };
  }
  if (cls === "reddit_ads.update_budget") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const title = `Change the daily budget of the Reddit ad group "${name}"`.slice(0, 300);
    const sentence = `Zavi changes the daily budget of "${name}" from ${usd(b.expected_current_daily_budget_usd)} to ${usd(b.daily_budget_usd)}.`;
    return { title, sentence, rows: [{ item: `Ad group "${name}"${ref}`, before: `${usd(b.expected_current_daily_budget_usd)} a day`, after: `${usd(b.daily_budget_usd)} a day` }] };
  }
  if (cls === "reddit_ads.set_object_status") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const kind = b.level === "ad_group" ? "ad group" : b.level;
    if (b.status === "ACTIVE") {
      const title = `Turn on the Reddit ${kind} "${name}"`.slice(0, 300);
      const sentence = `Zavi turns on the ${kind} "${name}" in Reddit Ads. If a Zavi ad budget is active when this runs, its ad group's daily budget is held from it first; with no ad budget, Zavi holds nothing and only Reddit's own budget and campaign limits apply. Spending resumes once Reddit approves the ads.`;
      return { title, sentence, rows: [{ item: `${kind} "${name}"${ref}`, before: live ? statusWord(live.configured_status) : "not read", after: "Active" }] };
    }
    const title = `Pause the Reddit ${kind} "${name}"`.slice(0, 300);
    const sentence = `Zavi pauses the ${kind} "${name}" in Reddit Ads. It stops spending until someone turns it back on.`;
    return { title, sentence, rows: [{ item: `${kind} "${name}"${ref}`, before: live ? statusWord(live.configured_status) : "not read", after: "Paused" }] };
  }
  if (cls === "reddit_ads.rename_object") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const kind = b.level === "ad_group" ? "ad group" : b.level;
    const title = `Rename the Reddit ${kind} "${name}" to "${b.new_name}"`.slice(0, 300);
    const sentence = `Zavi renames the ${kind} "${name}" in Reddit Ads. Its settings, budget and status do not change.`;
    return { title, sentence, rows: [{ item: `${kind} name${ref}`, before: name, after: b.new_name }] };
  }
  if (cls === "reddit_ads.remove_object") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const kind = b.level === "ad_group" ? "ad group" : b.level;
    const archive = b.mode === "archive";
    const title = `${archive ? "Archive" : "Delete"} the Reddit ${kind} "${name}"`.slice(0, 300);
    const sentence = archive
      ? `Zavi archives the paused ${kind} "${name}" in Reddit Ads. It stops for good and leaves the Ads Manager list; this cannot be undone.`
      : `Zavi deletes the archived ${kind} "${name}" from Reddit Ads. This cannot be undone.`;
    return { title, sentence, rows: [{ item: `${kind} "${name}"${ref}`, before: live ? statusWord(live.configured_status) : "not read", after: archive ? "Archived" : "Deleted" }] };
  }
  if (cls === "reddit_ads.update_targeting") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const title = `Change who sees the Reddit ad group "${name}"`.slice(0, 300);
    const sentence = `Zavi replaces the targeting of "${name}" in Reddit Ads. Budget, bidding and the ads themselves do not change.`;
    return { title, sentence, rows: [
      { item: "Countries or regions", before: was("geolocations", "none"), after: b.targeting.geolocations.join(", ") },
      { item: "Excluded countries or regions", before: was("excluded_geolocations", "none"), after: b.targeting.excluded_geolocations?.length ? b.targeting.excluded_geolocations.join(", ") : "none" },
      { item: "Communities", before: was("communities", "all"), after: b.targeting.communities.length ? b.targeting.communities.join(", ") : "all" },
      { item: "Interests", before: was("interests", "none"), after: b.targeting.interests.length ? b.targeting.interests.join(", ") : "none" },
      { item: "Placements", before: was("locations", "none"), after: b.targeting.locations.join(", ") },
    ] };
  }
  if (cls === "reddit_ads.update_ad") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const title = `Change the tracking link of the Reddit ad "${name}"`.slice(0, 300);
    const sentence = `Zavi changes the click link of "${name}" in Reddit Ads to ${b.destination_url}. It must open the same page as the ad's image post; the ad's words, picture and page do not change.`;
    return { title, sentence, rows: [{ item: `Ad "${name}"${ref} click link`, before: typeof live?.click_url === "string" ? live.click_url : "not read", after: b.destination_url }] };
  }
  if (cls === "reddit_ads.replace_creative") {
    const b = REDDIT_ACTION_SCHEMAS[cls].parse(body);
    const title = `Add the paused replacement ad "${b.creative.name}" to the Reddit ad group "${name}"`.slice(0, 300);
    const sentence = `Zavi creates a new paused image ad in "${name}" in Reddit Ads. The existing ad is unchanged; nothing spends until the new ad is turned on in a separate approval.`;
    return { title, sentence, rows: [
      { item: "Headline", before: "none", after: b.creative.headline },
      { item: "Destination", before: "none", after: b.creative.destination_url },
      ...(b.creative.click_url && b.creative.click_url !== b.creative.destination_url ? [{ item: "Click link (tracking)", before: "none", after: b.creative.click_url }] : []),
      { item: "Picture", before: "none", after: b.creative.image_url ?? (b.creative.image_path ? "The photo you attached in chat" : `Zavi image ${b.creative.image_artifact_id}`) },
      { item: "Status", before: "none", after: "Paused" },
    ] };
  }
  const b = REDDIT_ACTION_SCHEMAS["reddit_ads.authorize_account"].parse(body);
  const title = `Let Autopilot run Reddit Ads on account ${b.ad_account_id} within limits`.slice(0, 300);
  const sentence = `Zavi may prepare and launch Reddit traffic campaigns on this account for the chosen goal, up to ${usd(b.daily_limit_usd)} a day and ${usd(b.campaign_lifetime_limit_usd)} per campaign, until ${b.expires_at.slice(0, 10)}. This creates nothing by itself.`;
  return { title, sentence, rows: [
    { item: "Daily limit", before: "none", after: `${usd(b.daily_limit_usd)} a day` },
    { item: "Per-campaign limit", before: "none", after: usd(b.campaign_lifetime_limit_usd) },
    { item: "Countries or regions", before: "none", after: b.geolocations.join(", ") },
    { item: "Expires", before: "none", after: b.expires_at.slice(0, 10) },
  ] };
}

export async function resolveRedditAdsEmit(ctx: ExecEmitCtx): Promise<EmitDecisionFn | undefined> {
  const emit = await resolveChannelExecEmit(SWITCHED_REDDIT_CHANNELS, ctx, async (a) => {
    if (Object.hasOwn(REDDIT_ACTION_SCHEMAS, a.decision_class)) {
      const cls = a.decision_class as RedditActionClass;
      const body = REDDIT_ACTION_SCHEMAS[cls].parse(a.body);
      const { live, refusal } = await readRedditLiveResult(a.tenant_id, cls, body);
      if ((cls === "reddit_ads.rename_object" || cls === "reddit_ads.remove_object") && !live?.name) {
        throw new ExpectedToolError("reddit_ads_object_unreadable", refusal
          ? `Zavi could not read this object in Reddit, so it did not file the card: ${refusal} Nothing was proposed; trying again will not help until that changes.`
          : "Zavi could not read this object in Reddit, so it did not file the card. Nothing was proposed; read_objects again and propose it in a minute.");
      }
      const { title, sentence, rows } = describeRedditAction(cls, body, live);
      const { id } = await recordChannelExecAction({ tenantId: a.tenant_id, runId: a.run_id, channelSlug: a.channel_slug, execClass: cls, execPayload: body,
        actionType: cls === "reddit_ads.prepare_campaign" || cls === "reddit_ads.replace_creative" ? "create_ad" : "status" in body && body.status === "PAUSED" ? "pause_ad" : "update_ad",
        title, body: { step: { title, body: [sentence, body.rationale.trim()].filter(Boolean).join("\n\n"), blocking: false, effort: "minutes", evidence: [] }, change_sentence: sentence, exact_change: { rows }, decision_evidence: null, link: redditCampaignsUrl(body.ad_account_id) } });
      return id;
    }
    if (a.decision_class !== REDDIT_SET_STATUS_CLASS) {
      throw new ExpectedToolError(
        "channel_action_class_unknown",
        `Zavi does not know where a ${a.decision_class} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
      );
    }
    const { title, card } = buildRedditExecCardBody(a.body as RedditStatusBody);
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      actionType: "pause_ad",
      title,
      body: card,
    });
    return id;
  });
  if (emit !== ctx.emit_decision) return emit;
  return cgoChannelRailEmit(ctx, "reddit_ads", resolveRedditAdsEmit);
}
