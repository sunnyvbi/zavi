
import { ExpectedToolError } from "@/services/tools/types";
import { toBudgetMinorUnits } from "./_helpers";
import { checkNewAdSetBid, type MetaBidStrategy } from "./_decision-bodies";
import {
  assertTargetingGeo,
  assertTargetingInterestIds,
  assertTargetingPlacements,
  checkPromotedObjectForGoal,
  type PromotedObject,
  withAudienceMode,
} from "./_targeting-validate";

type ShapedRequest = { path: string; params: Record<string, string> };

export const LAUNCH_STATUS = "ACTIVE" as const;

const NAME_MAX = 100;

export function launchTag(actionId: string): string {
  const hex = actionId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (hex.length < 10) {
    throw new ExpectedToolError("meta_ads_invalid_target", "the action id is too short to tag a launch");
  }
  return `zv${hex.slice(0, 10)}`;
}

export function taggedName(base: string, tag: string): string {
  const suffix = ` · ${tag}`;
  const clean = base.replace(/\s+/g, " ").trim() || "Zavi launch";
  return `${clean.slice(0, NAME_MAX - suffix.length)}${suffix}`;
}

export function nameHasTag(name: string | null | undefined, tag: string): boolean {
  return typeof name === "string" && name.includes(tag);
}

function requireId(value: string | undefined | null, field: string): string {
  const v = (value ?? "").trim();
  if (!/^\d{5,25}$/.test(v)) throw new ExpectedToolError("meta_ads_invalid_target", `${field} must be a Meta object id`);
  return v;
}

export const COPY_STATUS = "PAUSED" as const;

export function shapeCopyAdSetRequest(input: { source_ad_set_id: string; tag: string; campaign_id?: string; rename?: "tag" | "none" }): ShapedRequest {
  const id = requireId(input.source_ad_set_id, "source_ad_set_id");
  const params: Record<string, string> = {
    deep_copy: "false",
    status_option: COPY_STATUS,
    rename_options:
      input.rename === "none"
        ? JSON.stringify({ rename_strategy: "NO_RENAME" })
        : JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` · ${input.tag}` }),
  };
  if (input.campaign_id) params.campaign_id = requireId(input.campaign_id, "campaign_id");
  return { path: `${id}/copies`, params };
}

export function shapeCopyCampaignRequest(input: { source_campaign_id: string; tag: string }): ShapedRequest {
  const id = requireId(input.source_campaign_id, "source_campaign_id");
  return {
    path: `${id}/copies`,
    params: {
      deep_copy: "false",
      status_option: COPY_STATUS,
      rename_options: JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` · ${input.tag}` }),
    },
  };
}

export function shapeCopiedAdRequest(input: { ad_account_id: string; ad_set_id: string; creative_id: string; name: string }): ShapedRequest {
  const account = (input.ad_account_id ?? "").trim();
  if (!account) throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id is required");
  return {
    path: `${account}/ads`,
    params: {
      name: input.name.slice(0, NAME_MAX) || "Ad",
      adset_id: requireId(input.ad_set_id, "ad_set_id"),
      creative: JSON.stringify({ creative_id: requireId(input.creative_id, "creative_id") }),
      status: COPY_STATUS,
    },
  };
}

export function shapeCopyAdWithCleanCreativeRequest(input: { source_ad_id: string; ad_set_id: string; degrees_of_freedom_spec: Record<string, unknown> }): ShapedRequest {
  const id = requireId(input.source_ad_id, "source_ad_id");
  return {
    path: `${id}/copies`,
    params: {
      adset_id: requireId(input.ad_set_id, "ad_set_id"),
      status_option: COPY_STATUS,
      rename_options: JSON.stringify({ rename_strategy: "NO_RENAME" }),
      creative_parameters: JSON.stringify({ degrees_of_freedom_spec: input.degrees_of_freedom_spec }),
    },
  };
}

export const STANDARD_ENHANCEMENTS_SUBCODE = 3858504;

export function withoutStandardEnhancements(dof: unknown): Record<string, unknown> {
  const d = dof && typeof dof === "object" && !Array.isArray(dof) ? (dof as Record<string, unknown>) : {};
  const features = d.creative_features_spec;
  const kept: Record<string, unknown> = {};
  if (features && typeof features === "object" && !Array.isArray(features)) {
    for (const [k, v] of Object.entries(features as Record<string, unknown>)) if (k !== "standard_enhancements") kept[k] = v;
  }
  return { ...d, creative_features_spec: kept };
}

export function readCopiedAdId(body: unknown): string | null {
  const b = (body ?? {}) as { copied_ad_id?: unknown; id?: unknown };
  const id = b.copied_ad_id ?? b.id;
  return id != null && String(id) ? String(id) : null;
}

export function shapeSetDailyBudgetRequest(
  input: { object_id: string; daily_budget_usd: number; name?: string },
  currency: string,
): ShapedRequest {
  const id = requireId(input.object_id, "object_id");
  const params: Record<string, string> = {
    daily_budget: String(toBudgetMinorUnits(input.daily_budget_usd, currency)),
  };
  if (input.name) params.name = input.name.slice(0, NAME_MAX);
  return { path: id, params };
}

export type CopiedObject = { type: string; source_id: string; copied_id: string };

export function readCopyResult(
  body: unknown,
  level: "adset" | "campaign",
): { copied_id: string | null; children: CopiedObject[] } {
  const b = (body ?? {}) as {
    copied_adset_id?: unknown;
    copied_campaign_id?: unknown;
    ad_object_ids?: Array<{ ad_object_type?: unknown; source_id?: unknown; copied_id?: unknown }>;
  };
  const top = level === "adset" ? b.copied_adset_id : b.copied_campaign_id;
  const children: CopiedObject[] = [];
  for (const o of Array.isArray(b.ad_object_ids) ? b.ad_object_ids : []) {
    if (o && o.source_id != null && o.copied_id != null) {
      children.push({ type: String(o.ad_object_type ?? ""), source_id: String(o.source_id), copied_id: String(o.copied_id) });
    }
  }
  return { copied_id: top != null && String(top) ? String(top) : null, children };
}

const DAY_SECONDS = 86_400;

export function shapeWebsiteAudienceRequest(input: {
  ad_account_id: string;
  pixel_id: string;
  retention_days: 30 | 90;
  name: string;
}): ShapedRequest {
  const account = (input.ad_account_id ?? "").trim();
  if (!account) throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id is required");
  const pixel = requireId(input.pixel_id, "pixel_id");
  if (input.retention_days !== 30 && input.retention_days !== 90) {
    throw new ExpectedToolError("meta_ads_invalid_audience", "retention_days must be 30 or 90");
  }
  const rule = {
    inclusions: {
      operator: "or",
      rules: [
        {
          event_sources: [{ id: pixel, type: "pixel" }],
          retention_seconds: input.retention_days * DAY_SECONDS,
          filter: { operator: "and", filters: [{ field: "url", operator: "i_contains", value: "" }] },
        },
      ],
    },
  };
  return {
    path: `${account}/customaudiences`,
    params: {
      name: input.name.slice(0, NAME_MAX),
      rule: JSON.stringify(rule),
      prefill: "true",
      description: `Website visitors in the last ${input.retention_days} days`,
    },
  };
}

export type LaunchCta =
  | "LEARN_MORE"
  | "SHOP_NOW"
  | "SIGN_UP"
  | "BOOK_TRAVEL"
  | "GET_OFFER"
  | "CONTACT_US"
  | "SUBSCRIBE"
  | "APPLY_NOW"
  | "DOWNLOAD"
  | "ORDER_NOW"
  | "GET_QUOTE";

export function metaUrlTags(input: { link_url?: string; tag: string }): string {
  const present = new Set<string>();
  try {
    if (input.link_url) new URL(input.link_url).searchParams.forEach((_v, k) => present.add(k));
  } catch {
  }
  const out: string[] = [];
  const add = (k: string, v: string) => {
    if (present.has(k)) return;
    present.add(k);
    out.push(`${k}=${v}`);
  };
  add("utm_source", "facebook");
  add("utm_medium", "paid_social");
  add(present.has("utm_campaign") ? "zavi_launch" : "utm_campaign", encodeURIComponent(input.tag));
  add("utm_content", "{{ad.id}}");
  add("utm_term", "{{adset.id}}");
  return out.join("&");
}

export function shapeLaunchCreativeRequest(input: {
  ad_account_id: string;
  page_id: string;
  name: string;
  primary_text: string;
  headline: string;
  link_url: string;
  cta: LaunchCta;
  image_url?: string;
  image_hash?: string;
  video_id?: string;
  thumbnail_url?: string;
  tag: string;
}): ShapedRequest {
  const account = (input.ad_account_id ?? "").trim();
  if (!account) throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id is required");
  const page_id = (input.page_id ?? "").trim();
  if (!page_id) throw new ExpectedToolError("meta_ads_page_required", "a Facebook Page is required for an ad");
  if (!/^https:\/\//i.test(input.link_url)) {
    throw new ExpectedToolError("meta_ads_invalid_link", "the ad's link must be an https URL");
  }
  const call_to_action = { type: input.cta, value: { link: input.link_url } };
  let spec: Record<string, unknown>;
  if (input.video_id) {
    if (!input.thumbnail_url) {
      throw new ExpectedToolError("meta_ads_video_thumbnail_missing", "a video ad needs a thumbnail");
    }
    spec = {
      page_id,
      video_data: {
        video_id: input.video_id,
        image_url: input.thumbnail_url,
        message: input.primary_text,
        title: input.headline,
        call_to_action,
      },
    };
  } else {
    if (!input.image_url && !input.image_hash) {
      throw new ExpectedToolError("meta_ads_invalid_media", "an ad needs an image or a video");
    }
    spec = {
      page_id,
      link_data: {
        link: input.link_url,
        message: input.primary_text,
        name: input.headline,
        ...(input.image_hash ? { image_hash: input.image_hash } : { picture: input.image_url }),
        call_to_action,
      },
    };
  }
  return {
    path: `${account}/adcreatives`,
    params: {
      name: input.name.slice(0, NAME_MAX),
      object_story_spec: JSON.stringify(spec),
      url_tags: metaUrlTags({ link_url: input.link_url, tag: input.tag }),
    },
  };
}

export function shapeLaunchAdRequest(input: {
  ad_account_id: string;
  ad_set_id: string;
  creative_id: string;
  name: string;
}): ShapedRequest {
  const account = (input.ad_account_id ?? "").trim();
  if (!account) throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id is required");
  const adset_id = requireId(input.ad_set_id, "ad_set_id");
  const creative_id = requireId(input.creative_id, "creative_id");
  return {
    path: `${account}/ads`,
    params: {
      name: input.name.slice(0, NAME_MAX),
      adset_id,
      creative: JSON.stringify({ creative_id }),
      status: LAUNCH_STATUS,
    },
  };
}

export function shapeLaunchAdSetRequest(
  input: {
    ad_account_id: string;
    campaign_id: string;
    name: string;
    optimization_goal: string;
    billing_event: string;
    targeting: Record<string, unknown>;
    promoted_object?: PromotedObject;
    bid_strategy: MetaBidStrategy;
    bid_amount_usd?: number;
    end_time?: string;
  },
  currency: string,
): ShapedRequest {
  const account = (input.ad_account_id ?? "").trim();
  if (!/^act_\d+$/.test(account)) throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id must look like act_<digits>");
  const campaign_id = requireId(input.campaign_id, "campaign_id");
  const goalErr = checkPromotedObjectForGoal(input.optimization_goal, input.promoted_object);
  if (goalErr) throw new ExpectedToolError("meta_ads_missing_promoted_object", goalErr);
  assertTargetingInterestIds(input.targeting);
  assertTargetingGeo(input.targeting);
  assertTargetingPlacements(input.targeting);
  const bidErr = checkNewAdSetBid(input.bid_strategy, input.bid_amount_usd);
  if (bidErr) throw new ExpectedToolError("meta_ads_invalid_bid", bidErr);
  return {
    path: `${account}/adsets`,
    params: {
      campaign_id,
      name: input.name.slice(0, NAME_MAX),
      optimization_goal: input.optimization_goal,
      billing_event: input.billing_event,
      targeting: JSON.stringify(withAudienceMode(input.targeting)),
      ...(input.promoted_object ? { promoted_object: JSON.stringify(input.promoted_object) } : {}),
      ...(input.bid_amount_usd !== undefined ? { bid_amount: String(toBudgetMinorUnits(input.bid_amount_usd, currency)) } : {}),
      ...(input.end_time ? { end_time: input.end_time.replace(/\.\d+(?=[+-]|Z)/, "").replace(/Z$/, "+00:00").replace(/([+-]\d{2}):(\d{2})$/, "$1$2") } : {}),
      status: COPY_STATUS,
    },
  };
}
