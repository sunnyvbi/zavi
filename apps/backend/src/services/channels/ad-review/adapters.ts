import { z } from "zod";
import type { AdReviewEditField } from "@zavi/shared";
import { createAdBodySchema as metaAd, launchCampaignBodySchema as metaLaunch, updateAdSetBodySchema as metaSchedule, createCreativeBodySchema as metaCreative } from "@/services/tools/meta-ads/write/_decision-bodies";
import { createAdBodySchema as googleAd, createCampaignBodySchema as googleLaunch } from "@/services/tools/google-ads/write/_decision-bodies";
import { tiktokLaunchBody } from "@/services/connectors/tiktok-ads/launch-schema";
import { prepareSchema } from "@/services/connectors/reddit-ads/schema";
import { createBody as xLaunch } from "@/services/connectors/x-ads/schema";
import { campaignReviewBundleSchema } from "@/services/connectors/chatgpt-ads/action-execution";
import { linkedinBundleSchema } from "@/services/connectors/linkedin-ads/action-execution";
import { CHATGPT_CREATE, growthCreateBody } from "@/services/connectors/chatgpt-ads/growth-actions";
import { record } from "./version";

const schemas: Readonly<Record<string, z.ZodType>> = {
  [CHATGPT_CREATE]: growthCreateBody,
  "meta_ads.create_ad": metaAd, "meta_ads.launch_campaign": metaLaunch,
  "meta_ads.create_creative": metaCreative, "meta_ads.update_ad_set": metaSchedule,
  "google_ads.create_ad": googleAd, "google_ads.create_campaign": googleLaunch,
  "tiktok_ads.create_launch": tiktokLaunchBody, "reddit_ads.prepare_campaign": prepareSchema,
  "x_ads.create_campaign": xLaunch, "chatgpt_ads.create_campaign_bundle": campaignReviewBundleSchema,
  "linkedin_ads.create_campaign_bundle": linkedinBundleSchema,
};

export function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => Array.isArray(node) ? node[Number(key)] : record(node) ? node[key] : undefined, value);
}

function writePath(value: unknown, path: string, next: unknown): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (!last) throw new Error("Invalid edit field.");
  const parent = keys.length ? atPath(value, keys.join(".")) : value;
  if (Array.isArray(parent)) parent[Number(last)] = next;
  else if (record(parent)) parent[last] = next;
  else throw new Error("This field is no longer available.");
}

export function editFields(execClass: string, payload: unknown): AdReviewEditField[] {
  if (!schemas[execClass]?.safeParse(payload).success) return [];
  const fields: AdReviewEditField[] = [];
  const add = (key: string, label: string, kind: AdReviewEditField["kind"], optional = false) => {
    const value = atPath(payload, key);
    fields.push({ key, label, kind, optional, value: kind === "datetime" ? typeof value === "number" ? new Date(value * 1000).toISOString().slice(0, 19) : "" : kind === "date" ? typeof value === "number" ? new Date(value * 1000).toISOString().slice(0, 10) : typeof value === "string" ? new Date(value).toISOString().slice(0, 10) : "" : Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "" });
  };
  const creative = (prefix: string, suffix = "") => {
    for (const [key, label, kind] of [
      ["title", "Title", "text"], ["headline", "Headline", "text"], ["primary_text", "Ad text", "multiline"],
      ["body", "Ad text", "multiline"], ["headlines", "Headlines (one per line)", "lines"],
      ["image_url", "Image URL", "url"], ["cta", "Call to action", "text"], ["call_to_action", "Call to action", "text"],
      ["long_headlines", "Long headlines (one per line)", "lines"], ["descriptions", "Descriptions (one per line)", "lines"],
      ["link_url", "Destination", "url"], ["target_url", "Destination", "url"], ["destination_url", "Destination", "url"],
      ["final_urls", "Destinations (one per line)", "lines"],
    ] satisfies Array<[string, string, AdReviewEditField["kind"]]>) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (atPath(payload, path) !== undefined) add(path, `${label}${suffix}`, kind);
    }
  };
  if (execClass === "meta_ads.launch_campaign") creative("ad");
  else if (execClass === "meta_ads.create_ad" || execClass === "meta_ads.create_creative") creative("");
  else if (execClass === "meta_ads.update_ad_set") add("end_time", "Ends (UTC)", "date");
  else if (execClass === "google_ads.create_ad") creative("ad");
  else if (execClass === "google_ads.create_campaign") {
    const ads = atPath(payload, "ad_group.ads");
    if (Array.isArray(ads)) ads.forEach((_, index) => creative(`ad_group.ads.${index}`, ` · Ad ${index + 1}`));
    creative("demand_gen_ad_group.ad");
    creative("pmax_asset_group");
  } else if (execClass === "tiktok_ads.create_launch") {
    add("ad_text", "Ad text", "multiline"); add("landing_url", "Destination", "url"); add("call_to_action", "Call to action", "text"); add("start_time", "Starts (UTC)", "date");
  } else if (execClass === "reddit_ads.prepare_campaign") {
    const ads = atPath(payload, "creatives");
    if (Array.isArray(ads)) ads.forEach((_, index) => creative(`creatives.${index}`, ` · Ad ${index + 1}`));
    add("start_time", "Starts (UTC)", "date");
  } else if (execClass === "x_ads.create_campaign") {
    add("tweet_ids", "Source post IDs (one per line)", "lines"); add("start_time", "Starts (UTC)", "date"); add("end_time", "Ends (UTC)", "date", true);
  } else if (execClass === CHATGPT_CREATE) {
    const ads = atPath(payload, "bundle.ads");
    if (Array.isArray(ads)) ads.forEach((_, index) => creative(`bundle.ads.${index}`, ` · Ad ${index + 1}`));
    add("bundle.campaign.start_time", "Starts (UTC)", "datetime");
    add("bundle.campaign.end_time", "Ends (UTC)", "datetime");
  } else if (execClass === "chatgpt_ads.create_campaign_bundle") {
    const ads = atPath(payload, "ads");
    if (Array.isArray(ads)) ads.forEach((_, index) => creative(`ads.${index}`, ` · Ad ${index + 1}`));
    add("campaign.start_time", "Starts (UTC)", "date", true); add("campaign.end_time", "Ends (UTC)", "date", true);
  }
  return fields;
}

export function reviseAdPayload(execClass: string, payload: unknown, changes: Record<string, string>): unknown {
  const fields = editFields(execClass, payload);
  const next = structuredClone(payload);
  for (const [key, value] of Object.entries(changes)) {
    const field = fields.find((item) => item.key === key);
    if (!field) throw new Error("This field cannot be edited for this proposal.");
    if (field.kind === "datetime") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("Choose a valid UTC date and time.");
      const normalized = value.length === 16 ? `${value}:00` : value;
      const ms = Date.parse(`${normalized}Z`);
      if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== normalized) throw new Error("Choose a valid UTC date and time.");
      writePath(next, key, ms / 1000);
    } else if (field.kind === "date") {
      if (!value && field.optional) writePath(next, key, null);
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid date.");
        const stamp = `${value}T${key.endsWith("end_time") ? "23:59:59" : "00:00:00"}Z`;
        if (!Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString().slice(0, 10) !== value) throw new Error("Choose a valid date.");
        writePath(next, key, execClass.startsWith("chatgpt_ads.") ? Date.parse(stamp) / 1000 : stamp);
      }
    } else writePath(next, key, field.kind === "lines" ? value.split("\n").map((line) => line.trim()).filter(Boolean) : value.trim());
  }
  const start = atPath(next, execClass === CHATGPT_CREATE ? "bundle.campaign.start_time" : execClass.startsWith("chatgpt_ads.") ? "campaign.start_time" : "start_time");
  const end = atPath(next, execClass === CHATGPT_CREATE ? "bundle.campaign.end_time" : execClass.startsWith("chatgpt_ads.") ? "campaign.end_time" : "end_time");
  if (start && end && (typeof start === "number" && typeof end === "number" ? end <= start : Date.parse(String(end)) <= Date.parse(String(start)))) throw new Error("The end date must be after the start date.");
  const parsed = schemas[execClass]?.safeParse(next);
  if (!parsed?.success) throw new Error(parsed?.error.issues[0]?.message ?? "This proposal cannot be edited.");
  return next;
}
