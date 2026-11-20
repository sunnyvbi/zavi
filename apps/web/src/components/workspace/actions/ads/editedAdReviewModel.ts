import type { AdReviewResponse } from "@zavi/shared";
import type { AdReviewModel } from "./adReviewModel";

function previewUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

export function editedAdReviewModel(model: AdReviewModel, fields: AdReviewResponse["fields"], values: Record<string, string>): AdReviewModel {
  let schedule = model.schedule ? { ...model.schedule } : null;
  let creatives = model.creatives.map((creative) => ({ ...creative }));
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === field.value) continue;
    const key = field.key.split(".").at(-1);
    if (key === "tweet_ids" || key === "post_urn") { creatives = []; continue; }
    if (field.kind === "datetime" && (key === "start_time" || key === "end_time")) {
      schedule = { start: schedule?.start ?? null, end: schedule?.end ?? null, [key === "start_time" ? "start" : "end"]: value ? `${value}Z` : null };
      continue;
    }
    if (field.kind === "date" && (key === "start_time" || key === "end_time")) {
      schedule = { start: schedule?.start ?? null, end: schedule?.end ?? null, [key === "start_time" ? "start" : "end"]: value ? `${value}T${key === "end_time" ? "23:59:59" : "00:00:00"}Z` : null };
      continue;
    }
    const position = /(?:ads|creatives)\.(\d+)\./.exec(field.key);
    const index = position ? Number(position[1]) : 0;
    const creative = creatives[index] ?? {};
    switch (key) {
      case "title": case "headline": case "headlines": case "long_headlines": creative.title = value.split("\n").filter(Boolean).join(" · "); break;
      case "body": case "primary_text": case "ad_text": case "descriptions": creative.body = value; break;
      case "image_url": creative.image_url = previewUrl(value); creative.image_path = undefined; break;
      case "link_url": case "target_url": case "destination_url": case "landing_url": case "final_urls": creative.target_url = previewUrl(value.split("\n")[0]); break;
      case "cta": case "call_to_action": creative.call_to_action = value; break;
      default: continue;
    }
    creatives[index] = creative;
  }
  return { ...model, creatives, schedule };
}
