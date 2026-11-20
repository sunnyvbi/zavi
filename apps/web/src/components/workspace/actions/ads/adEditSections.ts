import type { AdReviewEditField } from "@zavi/shared";
import { META_CTAS } from "../managed-campaigns/meta/metaEditorApi";
import { CALLS_TO_ACTION, words } from "../tiktok-campaigns/types";

export type AdEditSectionId = "media" | "words" | "link" | "schedule" | "details";
export type AdEditSection = { id: AdEditSectionId; title: string; fields: AdReviewEditField[] };
export type AdEditGroup = { ad: string | null; sections: AdEditSection[] };

const TITLES: Record<AdEditSectionId, string> = {
  media: "Image or video",
  words: "Words",
  link: "Link and button",
  schedule: "Schedule",
  details: "Details",
};
const ORDER: AdEditSectionId[] = ["media", "words", "link", "schedule", "details"];
const AD_SUFFIX = / · (Ad \d+)$/;

const leaf = (key: string) => key.split(".").pop() ?? key;

export function adEditSection(field: AdReviewEditField): AdEditSectionId {
  const name = leaf(field.key);
  if (name === "image_url") return "media";
  if (field.kind === "date" || field.kind === "datetime") return "schedule";
  if (field.kind === "url" || name === "final_urls" || name === "cta" || name === "call_to_action") return "link";
  if (["title", "headline", "primary_text", "body", "ad_text", "headlines", "long_headlines", "descriptions"].includes(name)) return "words";
  return "details";
}

const PLAIN: Record<string, string> = {
  primary_text: "Main text", body: "Main text", ad_text: "Main text",
  image_url: "Image link",
  link_url: "Link", target_url: "Link", destination_url: "Link", landing_url: "Link",
  cta: "Button", call_to_action: "Button",
};

export function adEditLabel(field: AdReviewEditField): string {
  return PLAIN[leaf(field.key)] ?? field.label.replace(AD_SUFFIX, "");
}

export function adEditGroups(fields: readonly AdReviewEditField[]): AdEditGroup[] {
  const groups: AdEditGroup[] = [];
  for (const field of fields) {
    const ad = AD_SUFFIX.exec(field.label)?.[1] ?? null;
    let group = groups.find((g) => g.ad === ad);
    if (!group) {
      group = { ad, sections: [] };
      groups.push(group);
    }
    const id = adEditSection(field);
    let section = group.sections.find((s) => s.id === id);
    if (!section) {
      section = { id, title: TITLES[id], fields: [] };
      group.sections.push(section);
    }
    section.fields.push(field);
  }
  for (const group of groups) group.sections.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return groups;
}

const LIMITS: Record<string, Record<string, number>> = {
  meta_ads: { primary_text: 125, body: 125, headline: 40, title: 40 },
  tiktok_ads: { ad_text: 100 },
  x_ads: { body: 280 },
};

export function adTextLimit(slug: string, field: AdReviewEditField): number | null {
  if (field.kind !== "text" && field.kind !== "multiline") return null;
  return LIMITS[slug]?.[leaf(field.key)] ?? null;
}

export function adButtonChoices(slug: string, field: AdReviewEditField): Array<{ value: string; label: string }> | null {
  const name = leaf(field.key);
  if (name !== "cta" && name !== "call_to_action") return null;
  const list = slug === "meta_ads"
    ? META_CTAS.map(([value, label]) => ({ value, label }))
    : slug === "tiktok_ads"
      ? CALLS_TO_ACTION.map((value) => ({ value, label: words(value) }))
      : null;
  if (!list) return null;
  return list.some((c) => c.value === field.value) || !field.value ? list : [{ value: field.value, label: words(field.value) }, ...list];
}
