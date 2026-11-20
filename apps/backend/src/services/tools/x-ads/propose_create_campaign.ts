import { assertXComposeAccess, assertXWriteAccess } from "@/services/connectors/x-ads/resources";
import { z } from "zod";
import { listXFundingInstruments, listXOwnPosts, xAdsTenantToken } from "@/services/connectors/x-ads/client";
import { round2 } from "@/services/connectors/core/ad-metrics";
import {
  assertBudgetOrder,
  audienceLabel,
  isoNow,
  money,
  xAges,
  xDaily,
  xGenders,
  xId,
  xKeywords,
  xLanguages,
  xLocations,
  xName,
  xTime,
  xDurationDays,
  xPostText,
  xTotal,
  X_OBJECTIVES,
  X_POST_MAX_CHARS,
  X_TWEET_ID_RE,
  type XCreateBody,
} from "@/services/connectors/x-ads/schema";
import type { ToolSpec } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { ExpectedToolError } from "@/services/tools/types";
import { X_CREATE_CAMPAIGN_CLASS } from "./_exec-action";
import { accountIdField, rationaleField, requireEmit } from "./_shared";

const inputSchema = z.object({
  account_id: accountIdField,
  funding_instrument_id: xId.describe("From x_ads_list_funding_instruments; must be able to fund."),
  name: xName,
  objective: z.enum(X_OBJECTIVES),
  daily_budget: xDaily.min(1).describe("Daily budget in the account's currency units."),
  total_budget: xTotal.optional().describe("Optional lifetime cap."),
  tweet_ids: z.array(z.string().regex(X_TWEET_ID_RE, "a post id is digits only")).max(10).optional().default([]).describe("Existing posts from the advertiser's own handle to promote. Never invent ids. Empty only with new_post_text."),
  new_post_text: xPostText.optional().describe(`One new post (at most ${X_POST_MAX_CHARS} characters, a link counts 23) published promoted-only at approval: it shows as an ad, never on the timeline.`),
  locations: xLocations.optional().default([]).describe("Location targets from x_ads_search_locations ({id, name}). Empty = no location limit."),
  excluded_locations: xLocations.optional().default([]).describe("Places the ads never show in, from x_ads_search_locations ({id, name}). Optional."),
  keywords: xKeywords.optional().default([]).describe("Broad-match keywords people engage with or search (at most 50). Optional."),
  languages: xLanguages.optional().default([]).describe("Two-letter language codes (en, es). Optional."),
  genders: xGenders.optional().default([]).describe("MALE, FEMALE or both; empty = everyone."),
  ages: xAges.optional().default([]).describe("X age buckets such as AGE_18_TO_34, AGE_25_TO_49, AGE_35_AND_OVER, AGE_50_AND_OVER; empty = all ages."),
  start_time: xTime.optional().describe("ISO 8601 time, e.g. 2026-10-05T00:00:00Z."),
  end_time: xTime.optional().describe("ISO 8601 time. Not with duration_days."),
  duration_days: xDurationDays.optional().describe("Stops this many days after it is created (the end is set at approval). Not with end_time."),
  launch: z.enum(["PAUSED", "ACTIVE"]).optional().default("PAUSED").describe("PAUSED unless the founder asked for it live."),
  rationale: rationaleField,
});

export const xAdsProposeCreateCampaignTool: ToolSpec = {
  name: "x_ads_propose_create_campaign",
  effect: "write",
  description:
    "Propose a new X Ads campaign that promotes existing posts or one new promoted-only post: funding instrument, name, objective, daily " +
    "budget (account currency units), optional total budget, post ids or new_post_text, optional locations, excluded locations, keywords, languages, genders, ages and dates, and " +
    "whether it launches PAUSED (default) or ACTIVE. Files an approval card; bounded new campaigns may be approved by Autopilot under its active shared ad budget. Other creates require a person.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = requireEmit(ctx.emit_decision);
    let a = inputSchema.parse(input);
    const { founderAskFor } = await import("@/services/approvals/approval-envelope");
    let ask = await founderAskFor(ctx, "x_ads");
    if (ask?.plan) {
      const p = ask.plan;
      const { flightEndMs, utcStamp } = await import("@/services/growth/ad-plan-shape");
      const endMs = flightEndMs(p, Date.now());
      ask = { ...ask, line: `${ask.line} It stops ${utcStamp(endMs)}.` };
      a = {
        ...a,
        daily_budget: p.budget_type === "lifetime" ? Math.max(1, Math.floor((p.total_usd / p.days) * 100) / 100) : p.daily_usd!,
        total_budget: p.budget_type === "lifetime" ? p.total_usd : undefined,
        start_time: undefined,
        end_time: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
        launch: "ACTIVE",
      };
    }
    const daily = round2(a.daily_budget);
    const total = a.total_budget === undefined ? null : round2(a.total_budget);
    assertBudgetOrder(daily, total);
    if (a.end_time && a.duration_days) throw new ExpectedToolError("x_ads_dates_invalid", "Pass end_time or duration_days, not both.");
    const end = a.end_time ? Date.parse(a.end_time) : null;
    if (end !== null && (end <= Date.now() || (a.start_time && end <= Date.parse(a.start_time)))) {
      throw new ExpectedToolError("x_ads_dates_invalid", "end_time must be in the future and after start_time.");
    }
    const token = await xAdsTenantToken(ctx.tenant_id);
    await assertXWriteAccess(token, a.account_id);
    if (a.new_post_text) await assertXComposeAccess(token, a.account_id);
    const fi = (await listXFundingInstruments(token, a.account_id)).find((f) => f.id === a.funding_instrument_id);
    if (!fi) throw new ExpectedToolError("x_ads_funding_not_found", `Funding instrument ${a.funding_instrument_id} is not on X Ads account ${a.account_id}.`);
    if (ask?.plan && fi.currency !== "USD") {
      throw new ExpectedToolError("x_ads_ask_not_usd", "This X Ads account is not in USD, so Zavi cannot run the founder's dollar ask as asked. Tell them to approve a card in the account's currency instead.");
    }
    if (!fi.able_to_fund) {
      throw new ExpectedToolError("x_ads_funding_unable", `"${fi.description}" cannot fund a campaign right now. The advertiser fixes it in X Ads Manager → Billing.`);
    }

    if (a.locations.some((l) => a.excluded_locations.some((x) => x.id === l.id))) {
      throw new ExpectedToolError("x_ads_locations_overlap", "A place cannot be both targeted and excluded. Nothing was proposed.");
    }
    const tweet_ids = [...new Set(a.tweet_ids)];
    const new_post = a.new_post_text ? { text: a.new_post_text } : null;
    if (tweet_ids.length === 0 && !new_post) {
      throw new ExpectedToolError("x_ads_no_post", "A campaign promotes existing post ids or one new_post_text. Nothing was proposed.");
    }
    if (a.objective === "FOLLOWERS" && (tweet_ids.length || new_post)) {
      throw new ExpectedToolError("x_ads_objective_unsupported", "Zavi promotes posts, and X runs a FOLLOWERS campaign on the account, not on posts. Pick ENGAGEMENTS, WEBSITE_CLICKS, REACH or VIDEO_VIEWS. Nothing was proposed.");
    }
    if (ctx.top_action_run === true && tweet_ids.length) {
      const own = await listXOwnPosts(token, a.account_id, tweet_ids);
      const foreign = tweet_ids.filter((id) => !own.has(id));
      if (foreign.length) {
        throw new ExpectedToolError(
          "x_ads_post_not_owned",
          `These posts are not from this X Ads account's own handle, so they cannot be promoted here: ${foreign.join(", ")}. Nothing was proposed. Tell the founder to paste links to posts they published from that account.`,
        );
      }
      const lacking = (k: "has_link" | "has_video") => tweet_ids.filter((id) => !own.get(id)?.[k]);
      if (a.objective === "WEBSITE_CLICKS" && lacking("has_link").length) {
        throw new ExpectedToolError("x_ads_post_no_link", `A website clicks campaign needs a link in every post, and these have none: ${lacking("has_link").join(", ")}. Nothing was proposed. Tell the founder to pick posts with a link, or the Engagement goal.`);
      }
      if (a.objective === "VIDEO_VIEWS" && lacking("has_video").length) {
        throw new ExpectedToolError("x_ads_post_no_video", `A video views campaign needs a video in every post, and these have none: ${lacking("has_video").join(", ")}. Nothing was proposed. Tell the founder to pick posts with a video, or the Engagement goal.`);
      }
    }
    if (new_post && a.objective === "WEBSITE_CLICKS" && !/https?:\/\/\S+/i.test(new_post.text)) {
      throw new ExpectedToolError("x_ads_post_no_link", "A website clicks campaign needs a link in the new post. Nothing was proposed.");
    }
    if (new_post && a.objective === "VIDEO_VIEWS") {
      throw new ExpectedToolError("x_ads_post_no_video", "A new post is text only, so it cannot run a video views campaign. Nothing was proposed.");
    }
    const audience = { keywords: [...new Set(a.keywords)], languages: [...new Set(a.languages)], genders: [...new Set(a.genders)], ages: [...new Set(a.ages)] };
    const n = tweet_ids.length + (new_post ? 1 : 0);
    const posts = new_post && !tweet_ids.length ? "one new post" : `${n} post${n === 1 ? "" : "s"}`;
    const launch = ctx.top_action_run === true ? "PAUSED" : a.launch;
    const live = launch === "ACTIVE";
    const row = (item: string, after: string) => ({ item, before: "None", after });
    const body: XCreateBody = {
      account_id: a.account_id,
      funding_instrument_id: fi.id,
      name: a.name,
      currency: fi.currency,
      objective: a.objective,
      daily_budget: daily,
      total_budget: total,
      tweet_ids,
      new_post,
      locations: a.locations,
      excluded_locations: a.excluded_locations,
      audience,
      start_time: a.start_time ?? isoNow(),
      end_time: a.end_time ?? null,
      duration_days: a.duration_days ?? null,
      launch,
      rationale: a.rationale,
      summary: live
        ? `Zavi starts "${a.name}" in X Ads, promoting ${posts}. It spends up to ${money(daily, fi.currency)} a day from the moment it is created.`
        : `Zavi builds "${a.name}" in X Ads, promoting ${posts}, and leaves it paused. Nothing spends until someone turns it on.`,
      exact_change: {
        rows: [
          row("Campaign", a.name),
          row("Objective", a.objective),
          row("Daily budget", money(daily, fi.currency)),
          ...(total !== null ? [row("Total budget", money(total, fi.currency))] : []),
          row("Paid by", fi.description),
          ...(tweet_ids.length ? [row("Promoted posts", tweet_ids.join(", "))] : []),
          ...(new_post ? [row("New post (promoted only)", new_post.text)] : []),
          row("Locations", a.locations.length ? a.locations.map((l) => l.name).join(", ") : "Anywhere X serves"),
          ...(a.excluded_locations.length ? [row("Excluded locations", a.excluded_locations.map((l) => l.name).join(", "))] : []),
          ...(audience.keywords.length ? [row("Keywords", audience.keywords.join(", "))] : []),
          ...(audience.languages.length ? [row("Languages", audience.languages.join(", "))] : []),
          ...(audience.genders.length ? [row("Gender", audience.genders.map(audienceLabel).join(", "))] : []),
          ...(audience.ages.length ? [row("Ages", audience.ages.map(audienceLabel).join(", "))] : []),
          ...(a.start_time ? [row("Starts", `${a.start_time} (or when approved, if later)`)] : []),
          ...(a.end_time ? [row("Ends", a.end_time)] : a.duration_days ? [row("Ends", `${a.duration_days} day${a.duration_days === 1 ? "" : "s"} after it ${a.start_time ? "starts" : "is created"}`)] : []),
          row("Status", live ? "Active" : "Paused"),
        ],
      },
    };
    const filed = isHumanAuthoredCommand(ctx, "budget") ? { ...body, origin: "user_initiated_chat" as const } : body;
    const action_id = await emit(X_CREATE_CAMPAIGN_CLASS, filed);
    return { action_id, status: "waiting_for_founder", campaign: { name: a.name, launch }, ...(ask?.line ? { say_to_founder: ask.plan && ask.source === "ask" ? await (await import("@/services/approvals/envelope-door")).directAskSay(ctx.tenant_id, action_id, ask.line, "X") : ask.line } : {}) };
  },
};
