
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokAdsAccount } from "@/services/connectors/tiktok-ads/composio-read";
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { TIKTOK_CREATE_LAUNCH_CLASS, TIKTOK_MAX_DAILY_USD } from "@/services/connectors/tiktok-ads/held-schema";
import { verifyTiktokLocations } from "@/services/connectors/tiktok-ads/locations";
import { signedUploadedVideoUrl, signedZaviVideoUrl } from "@/services/connectors/tiktok-ads/zavi-videos";
import { assertLandingUrl, readLaunchReadiness, readLaunchVideo, throwBlocker, uploadLaunchVideo, type TiktokVideo } from "@/services/connectors/tiktok-ads/launch-readiness";
import { assertNothingInFlight, readLaunchInFlight } from "@/services/connectors/tiktok-ads/launch-in-flight";
import { videoSourceKey, videoUploadStore } from "@/services/connectors/tiktok-ads/video-uploads";
import {
  LAUNCH_MEASURED_LINE,
  LINK_TIKTOK_ACCOUNT_STEPS,
  TIKTOK_LAUNCH_CTAS,
  TIKTOK_MAX_LOCATIONS,
  floorRefusal,
  flightDaysTo,
  launchHoldUsd,
  launchRefusal,
  scheduleStart,
  scheduleEnd,
  tiktokLaunchBody,
  videoRefusal,
} from "@/services/connectors/tiktok-ads/launch-schema";

import { normalizeTiktokAudience, tiktokAgeGroupsSchema, tiktokGenderSchema, tiktokLanguagesSchema, verifyTiktokLanguages } from "@/services/connectors/tiktok-ads/targeting";
import { advancedGroupShape, advancedGroupValues, verifyAdvancedGroup } from "@/services/connectors/tiktok-ads/campaign-advanced";

const numericId = (what: string) => z.string().min(1).max(32).regex(/^[0-9]+$/, `${what} must be a numeric TikTok id`);

const readinessInput = z.object({
  advertiser_id: numericId("advertiser_id").optional().describe("TikTok ad account, from tiktok_ads_list_accounts. Left out: the account the founder chose."),
});

export const tiktokAdsLaunchReadinessTool: ToolSpec = {
  name: "tiktok_ads_launch_readiness",
  effect: "read",
  description:
    "Facts for a new TikTok launch, read live, with no recommendation: the ad account's status, currency and time zone; " +
    "the linked TikTok accounts an ad can run as (identity_id, identity_type, identity_authorized_bc_id); Zavi's videos for this company; " +
    "TikTok's minimum daily budgets; possible_campaign_types; allowed_locations (the company's own country, the default place); the shared ad budget left; " +
    "blockers[], each with the founder's exact fix; and already_launching[] (a switched-on Zavi campaign, an open launch card, a launch waiting for budget room), " +
    "empty when none is under way. Call it before tiktok_ads_propose_launch; places beyond allowed_locations come from tiktok_ads_search_locations. Read-only.",
  input_schema: readinessInput,
  async execute(ctx, input) {
    const { advertiser_id } = readinessInput.parse(input);
    const r = await readLaunchReadiness(ctx.tenant_id, { advertiser_id });
    const already_launching = r.advertiser ? await readLaunchInFlight(ctx, await tiktokAdsAccount(ctx.tenant_id), r.advertiser.advertiser_id) : [];
    return { ...r, already_launching };
  },
};

const proposeInput = z.object({
  ...advancedGroupShape,
  advertiser_id: numericId("advertiser_id").optional().describe("TikTok ad account. Left out: the account the founder chose."),
  campaign_type: z.string().min(1).max(40).describe("One of possible_campaign_types from tiktok_ads_launch_readiness."),
  name: z.string().min(1).max(80).describe("A short name for the campaign. Zavi adds its prefix and launch tag."),
  location_ids: z.array(numericId("location_id")).min(1).max(TIKTOK_MAX_LOCATIONS).describe("Where the ads show, 1 to 25 ids: allowed_locations from tiktok_ads_launch_readiness (the company's country) or places from tiktok_ads_search_locations. Include-only; TikTok has no exclude list. Any id TikTok does not let this account target is refused."),
  age_groups: tiktokAgeGroupsSchema.optional().describe("Adult age buckets. Leave out or empty for every adult age (18+), explicitly sent to TikTok. Preserve any founder selection."),
  gender: tiktokGenderSchema.optional().describe("Leave out for all genders. Narrow only when the founder asks."),
  languages: tiktokLanguagesSchema.optional().describe("Language codes from tiktok_ads_targeting_options. Empty or omitted means all languages. Never infer a restriction from the ad language; preserve the founder selection."),
  daily_budget_usd: z.number().positive().max(TIKTOK_MAX_DAILY_USD).describe("The ad group's daily budget in USD; must be more than $20."),
  start_time: z.string().max(40).optional().describe("ISO date-time to start (now or later). Left out: as soon as it is approved."),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD (UTC, exclusive): the ad group stops then. Left out: runs until paused."),
  video_artifact_id: z.string().uuid().optional().describe("A Zavi video from videos[] in tiktok_ads_launch_readiness. Give exactly one of video_artifact_id, video_upload_path, video_url, video_id."),
  video_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("An existing video in the selected advertiser's library. It is verified live and reused without uploading another copy."),
  video_upload_path: z.string().max(200).optional().describe("A video the founder uploaded (<workspace id>/<uuid>.mp4), only when the founder named one."),
  video_url: z.string().max(2000).optional().describe("An https link to a video the founder gave you."),
  identity_id: z.string().min(1).max(64).describe("The linked TikTok account the ad runs as, from identities[] in tiktok_ads_launch_readiness."),
  ad_text: z.string().min(1).max(100).describe("The ad's caption, 1-100 characters."),
  call_to_action: z.enum(TIKTOK_LAUNCH_CTAS),
  landing_url: z.string().min(1).max(2000).describe("The https page a tap opens. Zavi adds its UTM tag."),
  rationale: z.string().min(1).max(1000).describe("Why this launch, citing what you read this run."),
}).refine(v => [v.video_artifact_id, v.video_upload_path, v.video_url, v.video_id].filter(Boolean).length === 1, { message: "Choose exactly one video source.", path: ["video_id"] });

const VIDEO_INFO_ATTEMPTS = 3;
const VIDEO_INFO_WAIT_MS = process.env.NODE_ENV === "test" ? 0 : 2000;

async function measuredVideo(account: Awaited<ReturnType<typeof tiktokAdsAccount>>, advertiserId: string, videoId: string): Promise<TiktokVideo | null> {
  let v: TiktokVideo | null = null;
  for (let i = 0; i < VIDEO_INFO_ATTEMPTS; i++) {
    v = await readLaunchVideo(account, advertiserId, videoId);
    if (v && v.width !== null && v.height !== null && v.duration_s !== null && v.allowed_placements !== null) return v;
    if (VIDEO_INFO_WAIT_MS) await new Promise((r) => setTimeout(r, VIDEO_INFO_WAIT_MS));
  }
  return v;
}

export const tiktokAdsProposeLaunchTool: ToolSpec = {
  name: "tiktok_ads_propose_launch",
  effect: "write",
  description:
    "Propose ONE new TikTok launch: a TRAFFIC campaign (no budget of its own), one ad group carrying the daily budget in the chosen places, " +
    "and one video ad run as a linked TikTok account. Files ONE card on the TikTok Ads channel's Actions tab showing every choice, the amount " +
    "the shared ad budget will hold, and what is measured (clicks and site visits, not sales). Nothing is created until it is approved: by a " +
    "workspace owner or admin, or by Autopilot within its ad budget (the result's status says which). Choose the identity, video and campaign type from " +
    "tiktok_ads_launch_readiness and places from its allowed_locations or tiktok_ads_search_locations. Language codes come from tiktok_ads_targeting_options; " +
    "preserve the founder's age, gender and language choices, or keep the broad defaults.",
  input_schema: proposeInput,
  async execute(ctx, input) {
    const parsed = proposeInput.safeParse(input);
    if (!parsed.success) {
      if (parsed.error.issues.some(issue => issue.code === "custom" && issue.path[0] === "video_id")) throw launchRefusal("tiktok_ads_no_usable_video", "A launch needs exactly one video.", "choose a library video, a Zavi video, an upload or a public HTTPS link.");
      throw parsed.error;
    }
    let args = parsed.data;
    const { founderAskFor } = await import("@/services/approvals/approval-envelope");
    const ask = await founderAskFor(ctx, "tiktok_ads");
    if (ask?.plan) args = { ...args, daily_budget_usd: ask.plan.daily_usd!, end_date: ask.plan.end, start_time: undefined };
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError("tiktok_ads_propose_not_channel_run", "This tool files a card on the TikTok Ads channel and only works on a TikTok Ads channel run. Nothing was proposed.");
    }
    const r = await readLaunchReadiness(ctx.tenant_id, { advertiser_id: args.advertiser_id, videos: false });
    throwBlocker(r);
    const adv = r.advertiser!;
    const account = await tiktokAdsAccount(ctx.tenant_id);
    if (!r.possible_campaign_types.includes(args.campaign_type)) {
      throw launchRefusal("tiktok_ads_campaign_type_unsupported", `"${args.campaign_type}" is not a campaign type Zavi can launch on TikTok.`, `use one of: ${r.possible_campaign_types.join(", ")}.`);
    }
    const known = new Map(r.allowed_locations.map((l) => [l.location_id, l]));
    const unknown = [...new Set(args.location_ids)].filter((id) => !known.has(id));
    for (const p of unknown.length ? await verifyTiktokLocations(account, adv.advertiser_id, unknown) : []) known.set(p.location_id, p);
    const locations = [...new Set(args.location_ids)].map((id) => known.get(id));
    if (locations.some((l) => !l)) {
      throw launchRefusal(
        "tiktok_ads_location_not_allowed",
        `Location ${args.location_ids.join(", ")} is not where this company may advertise.`,
        `use allowed_locations from tiktok_ads_launch_readiness (${r.allowed_locations.map((l) => `${l.location_id} ${l.name}`).join(", ") || "none"}).`,
      );
    }
    const audience = normalizeTiktokAudience(args);
    const languageOptions = await verifyTiktokLanguages(account, adv.advertiser_id, audience.languages);
    const advanced = advancedGroupValues(args);
    await verifyAdvancedGroup(account, adv.advertiser_id, advanced, { bid_type: "BID_TYPE_NO_BID" });
    const identity = r.identities.find((i) => i.identity_id === args.identity_id);
    if (!identity) {
      throw launchRefusal("tiktok_ads_no_identity", `${args.identity_id} is not a linked TikTok account this ad account can run ads as (custom identities are no longer accepted by TikTok).`, LINK_TIKTOK_ACCOUNT_STEPS);
    }
    const floor = floorRefusal(args.daily_budget_usd);
    if (floor) throw floor;
    if (!/^https:\/\//i.test(args.landing_url)) {
      throw launchRefusal("tiktok_ads_landing_url_unsafe", "The landing page must be an https address.", "use the https address of a public page on the company's site.");
    }
    await assertLandingUrl(args.landing_url);
    assertNothingInFlight(await readLaunchInFlight(ctx, account, adv.advertiser_id));
    const now = Date.now();
    const start = args.start_time ? Date.parse(args.start_time) : now;
    if (!Number.isFinite(start)) throw launchRefusal("tiktok_ads_start_invalid", `"${args.start_time}" is not a date and time.`, "give an ISO date-time, or leave it out to start on approval.");
    if (start < now - 10 * 60_000) throw launchRefusal("tiktok_ads_start_invalid", "The start time has already passed.", "give a time from now on, or leave it out to start on approval.");
    scheduleStart(new Date(start).toISOString(), new Date(now), adv.timezone!);
    if (args.end_date) {
      scheduleEnd(args.end_date, adv.timezone!);
      const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
      if (!(await adsNoFrictionEnabled())) throw launchRefusal("tiktok_ads_end_date_off", "TikTok end dates are turned off.", "leave end_date out.");
      if (Date.parse(`${args.end_date}T00:00:00Z`) <= Math.max(start, now) + 3_600_000) throw launchRefusal("tiktok_ads_end_invalid", "The end date must be after the start.", "give a later end_date.");
    }

    let hold: number | null = null;
    if (r.ad_budget === "unreadable") {
      throw launchRefusal("tiktok_ads_budget_unreadable", "Zavi's ad budget could not be checked, so the amount this launch holds is unknown.", "ask again in a minute.");
    }
    if (r.ad_budget) {
      hold = launchHoldUsd(args.daily_budget_usd, r.ad_budget.days_left, r.ad_budget.margin, flightDaysTo(args.end_date, new Date(now)), 1.25);
      if (hold > r.ad_budget.left_usd && !ask?.plan) {
        const what = `At $${args.daily_budget_usd.toFixed(2)} a day this launch holds $${hold.toFixed(2)} for the rest of the month, and the ad budget has $${r.ad_budget.left_usd.toFixed(2)} left.`;
        const { budgetShortFix } = await import("@/services/growth/pending-test-claim");
        const fix = ctx.top_action_run
          ? "raise the ad budget on the Growth page, or choose a smaller daily budget and submit again. No launch was queued."
          : await budgetShortFix(ctx, { channel: "tiktok_ads", daily_budget_usd: args.daily_budget_usd, hold_usd: hold, proposal: args as unknown as Record<string, unknown> });
        throw launchRefusal("tiktok_ads_budget_short", what, fix);
      }
    }

    if ((ctx as { redo?: boolean }).redo) {
      throw new ExpectedToolError("redo_scope", "This run is redoing one action you were asked to rewrite. It cannot propose a launch as well; propose it on a normal run of this channel.");
    }
    if (ctx.writes_suppressed) {
      return { action_id: "channel_action_suppressed", status: "not_filed", note: "This run writes nothing: no card was filed and no video was uploaded." };
    }
    await (await import("@/services/growth/pending-test-claim")).assertNoWaitingTest(ctx, "tiktok_ads");

    let videoId: string | null = args.video_id ?? null;
    let linkHost: string | undefined;
    if (!videoId) {
      let videoUrl: string;
      let fileName: string;
      if (args.video_artifact_id) {
        const z1 = await signedZaviVideoUrl(ctx.tenant_id, args.video_artifact_id);
        videoUrl = z1.url;
        fileName = z1.filename;
      } else if (args.video_upload_path) {
        const u1 = await signedUploadedVideoUrl(ctx.tenant_id, args.video_upload_path);
        videoUrl = u1.url;
        fileName = u1.filename;
      } else {
        try {
          const u = await assertSafeUrl(args.video_url!);
          linkHost = u.hostname;
          videoUrl = u.toString();
          fileName = u.pathname.split("/").pop() || "video.mp4";
        } catch (e) {
          if (!(e instanceof SsrfBlockedError)) throw e;
          throw launchRefusal("tiktok_ads_video_url_unsafe", "The video link is not a public https address.", "send an https link to the video file.");
        }
      }
      const uploads = videoUploadStore(ctx.tenant_id);
      const key = videoSourceKey(
        args.video_artifact_id ? { artifact_id: args.video_artifact_id } : args.video_upload_path ? { upload_path: args.video_upload_path } : { url: videoUrl },
      );
      videoId = await uploads.find(adv.advertiser_id, key);
      if (videoId && !(await readLaunchVideo(account, adv.advertiser_id, videoId).catch(() => null))) videoId = null;
      if (!videoId) {
        videoId = await uploadLaunchVideo(account, adv.advertiser_id, videoUrl, `zavi-${fileName}`);
        await uploads.remember(adv.advertiser_id, key, videoId);
      }
    }
    const video = await measuredVideo(account, adv.advertiser_id, videoId);
    if (!video) throw launchRefusal("tiktok_ads_video_unreadable", args.video_id ? "That video is not readable in the selected ad account's library." : "TikTok took the video but does not list it yet.", "choose a video from this ad account, or try again once processing finishes.");
    const bad = videoRefusal(video);
    if (bad) throw bad;

    const body = tiktokLaunchBody.parse({
      advertiser_id: adv.advertiser_id,
      advertiser_name: adv.name,
      campaign_type: args.campaign_type,
      name: args.name,
      locations: locations.map((l) => ({ location_id: l!.location_id, country_code: l!.country_code, name: l!.name, ...(l!.level ? { level: l!.level } : {}) })),
      ...audience,
      ...advanced,
      language_names: languageOptions.map((l) => l.name),
      daily_budget_usd: args.daily_budget_usd,
      budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
      start_time: new Date(Math.max(start, now)).toISOString(),
      ...(args.end_date ? { end_date: args.end_date } : {}),
      video: {
        video_id: videoId,
        source: args.video_id ? "library" : args.video_artifact_id ? "zavi" : args.video_upload_path ? "upload" : "link",
        ...(args.video_artifact_id ? { artifact_id: args.video_artifact_id } : {}),
        ...(linkHost ? { link_host: linkHost } : {}),
        width: video.width,
        height: video.height,
        duration_s: video.duration_s,
      },
      identity: {
        identity_id: identity.identity_id,
        identity_type: identity.identity_type,
        ...(identity.identity_authorized_bc_id ? { identity_authorized_bc_id: identity.identity_authorized_bc_id } : {}),
        display_name: identity.display_name,
      },
      ad_text: args.ad_text,
      call_to_action: args.call_to_action,
      landing_url: args.landing_url,
      hold_estimate_usd: hold,
      rationale: args.rationale,
      origin: ctx.top_action_run === true ? "user_initiated_ledger" : "specialist",
    });
    const action_id = await (ctx.emit_decision as (c: string, b: unknown) => Promise<string>)(TIKTOK_CREATE_LAUNCH_CLASS, body);
    const { PENDING_TEST_REPLAY } = await import("@/services/growth/pending-test-claim");
    const replay = (ctx as { [PENDING_TEST_REPLAY]?: boolean })[PENDING_TEST_REPLAY] === true;
    let approved = false;
    let byAsk = false;
    if (!replay && action_id !== "channel_action_suppressed") {
      if (ask?.plan) {
        const { asTenantId, tenantClient } = await import("@/services/tenant-client");
        const { data } = await tenantClient(asTenantId(ctx.tenant_id)).from("channel_actions").select("exec_status, approved_by_source").eq("id", action_id).maybeSingle();
        const row = data as { exec_status?: string | null; approved_by_source?: string | null } | null;
        byAsk = !!row?.exec_status && row.approved_by_source == null;
      }
      if (!byAsk && body.origin === "specialist" && ask?.source !== "ask") {
        const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
        approved = await cgoApproveChannelAction(ctx.tenant_id, action_id);
      }
    }
    return {
      action_id,
      status: byAsk ? "approved_by_founder_ask" : approved ? "approved_by_autopilot" : "waiting_for_approval",
      note: byAsk
        ? "The founder's own ask approved this launch. Zavi is creating it on TikTok now; read the card for the result before telling the founder it is live."
        : approved
          ? "Autopilot approved this launch within the ad budget. Zavi is creating it on TikTok now; read the card for the result before telling the founder it is live."
          : "Filed on the TikTok Ads Actions tab. Nothing is created until it is approved.",
      ...(await (async () => {
        const say = ask?.plan && ask.source === "ask" && !replay
          ? await (await import("@/services/approvals/envelope-door")).directAskSay(ctx.tenant_id, action_id, ask.line, "TikTok")
          : ask?.line;
        return say ? { say_to_founder: say } : {};
      })()),
      video_id: videoId,
      hold_estimate_usd: hold,
      measured: LAUNCH_MEASURED_LINE,
    };
  },
};
