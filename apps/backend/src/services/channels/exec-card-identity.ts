
import { normalizeRef, type CardTarget } from "./card-matcher";

export const TARGET_KEY_MAX = 300;

const FREE_TEXT_KEYS = ["rationale", "decision_evidence", "about"] as const;
const NAME_KEYS = ["name", "campaign_name"] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

const CREATOR_HIRE_CLASS = "creator.hire";

export function execSkipsMatcher(execClass: string): boolean {
  return execClass === CREATOR_HIRE_CLASS;
}

export function execFamily(execClass: string): string {
  return execClass.replace(/_review$/, "");
}

export function execCardTarget(execClass: string, payload: Record<string, unknown>): CardTarget | null {
  const p = payload ?? {};
  if (execClass === CREATOR_HIRE_CLASS) {
    const order = str(p.order_id);
    return order ? { kind: "creator_order", ref: order } : null;
  }
  if (execFamily(execClass) === "generated_video.render.v1") {
    const script = str((p.intake as { script?: unknown } | undefined)?.script);
    return script ? { kind: "post", ref: `ai video ${str(p.format) ?? ""} ${script}` } : null;
  }
  if (execFamily(execClass) === "seo.create_pr.v1" || execFamily(execClass) === "geo.create_pr.v1") {
    const page = str(p.page_url) ?? (execFamily(execClass) === "geo.create_pr.v1" ? "robots.txt" : null);
    return page ? { kind: "page", ref: page } : null;
  }
  const name = str(p.name) ?? str(p.campaign_name);
  const conversion = str(p.conversion_action_name) ?? str(p.conversion_action) ?? str(p.conversion_action_id);
  if (conversion) return { kind: "tracking", ref: conversion };
  const cls = execFamily(execClass);
  if (cls === "google_ads.create_campaign") return name ? { kind: "campaign", ref: name } : null;
  if (cls === "google_ads.create_ad_group" || cls === "meta_ads.create_ad_set") {
    return name ? { kind: "ad_set", ref: name } : null;
  }
  if (cls === "google_ads.create_ad" || cls === "meta_ads.create_ad") {
    const group = str(p.ad_group_id) ?? str(p.ad_set_id);
    return group ? { kind: "ad_set", ref: group } : null;
  }
  if (cls === "meta_ads.duplicate_ad_set") {
    const src = str(p.source_ad_set_id);
    return src ? { kind: "ad_set", ref: src } : null;
  }
  if (cls === "meta_ads.launch_campaign") {
    const campaign = str((p.campaign as { name?: unknown } | undefined)?.name);
    return campaign ? { kind: "campaign", ref: campaign } : null;
  }
  if (cls === "meta_ads.duplicate_campaign") {
    const src = str(p.source_campaign_id);
    return src ? { kind: "campaign", ref: src } : null;
  }
  const level = str(p.level);
  if (level === "keyword" || str(p.criterion_id)) {
    const kw = str(p.keyword_text) ?? str(p.criterion_id);
    return kw ? { kind: "keyword", ref: kw } : null;
  }
  if (level === "ad" || str(p.ad_id)) {
    const ad = name ?? str(p.ad_id);
    return ad ? { kind: "ad", ref: ad } : null;
  }
  const setId = str(p.ad_set_id) ?? str(p.ad_group_id) ?? (level === "adset" ? str(p.object_id) : null);
  if (level === "adset" || level === "ad_group" || str(p.ad_set_id) || (str(p.ad_group_id) && !level)) {
    const ref = name ?? setId;
    return ref ? { kind: "ad_set", ref } : null;
  }
  return name ? { kind: "campaign", ref: name } : null;
}

export function targetKeyOf(t: CardTarget | null | undefined): string | null {
  if (!t || t.kind === "queue" || !String(t.ref ?? "").trim()) return null;
  return normalizeRef(t).slice(0, TARGET_KEY_MAX);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function without(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k) && v !== undefined) out[k] = v;
  return out;
}

export function execSubject(actionType: string | null | undefined, payload: Record<string, unknown>): string | null {
  if (actionType !== "update_ad" && actionType !== "pause_ad") return null;
  const p = payload ?? {};
  const id = (k: string) => {
    const v = p[k];
    return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
  };
  const obj = id("criterion_id") ?? id("ad_id") ?? id("object_id") ?? id("ad_set_id") ?? id("ad_group_id") ?? id("campaign_id");
  if (!obj) return null;
  return [p.level, p.parent_id, obj].filter((x) => x !== null && x !== undefined).map(String).join("|");
}

export function execLayer1Keys(execClass: string, actionType: string | null | undefined, payload: Record<string, unknown>): string[] {
  const family = execFamily(execClass);
  const keys: string[] = [];
  const subject = execSubject(actionType, payload);
  if (subject !== null) keys.push(`${family}|subject:${subject}`);
  const norm = without(payload ?? {}, FREE_TEXT_KEYS);
  if (Object.keys(without(norm, NAME_KEYS)).length > 0) keys.push(`${family}|payload:${canonical(norm)}`);
  return keys;
}
