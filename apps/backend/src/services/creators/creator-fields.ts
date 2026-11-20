
import { SELF_REPORTED_LABEL, feeBreakdown, socialUrl, type FeeBreakdown } from "@zavi/shared";

export const SELF_REPORTED_NOTE =
  "Self-reported by the creator. Zavi has not checked these numbers.";

export const NOT_BOOKABLE_COPY: Record<string, string> = {
  payout_country_unsupported:
    "Cannot be booked yet. Zavi can only pay creators in the US, Canada, the UK, the EEA and Switzerland today, and this creator is somewhere else.",
};

export function notBookableMessage(reason: string | null): string | null {
  if (!reason) return null;
  return NOT_BOOKABLE_COPY[reason] ?? "Cannot be booked yet.";
}

export type CreatorAudienceEntry = {
  label: string;
  value: string;
  self_reported: true;
};

export type CreatorSocial = {
  platform: string;
  handle: string;
  url: string | null;
  followers: number | null;
  label: string;
};

export type CreatorPackageView = {
  id: string;
  kind: "ugc_video";
  title: string;
  description: string | null;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: Array<{ code: string; price_cents: number }>;
  pricing: FeeBreakdown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const METRICS_ENVELOPE_KEYS = new Set(["self_reported", "disclaimer", "note"]);

export function toSelfReportedAudience(raw: unknown): CreatorAudienceEntry[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const label = (k: string) => k.replace(/[_-]+/g, " ").trim();
  const out: CreatorAudienceEntry[] = [];

  if (Array.isArray(obj.audience)) {
    for (const item of obj.audience) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      const platform = typeof e.platform === "string" ? e.platform.trim() : "";
      const followers = typeof e.followers === "number" ? e.followers : Number(e.followers);
      if (!platform || !Number.isFinite(followers) || followers < 0) continue;
      out.push({ label: `${label(platform)} followers`, value: String(Math.trunc(followers)), self_reported: true });
    }
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === "audience" || METRICS_ENVELOPE_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "string" || typeof v2 === "number") {
          out.push({ label: `${label(k)} ${label(k2)}`, value: String(v2), self_reported: true });
        }
      }
      continue;
    }
    if (typeof v === "string" || typeof v === "number") {
      out.push({ label: label(k), value: String(v), self_reported: true });
    }
  }
  return out;
}

export function projectSocials(raw: unknown): CreatorSocial[] {
  if (!Array.isArray(raw)) return [];
  const out: CreatorSocial[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const h = item as Record<string, unknown>;
    const platform = str(h.platform).trim();
    const handle = str(h.handle).trim();
    if (!platform || !handle) continue;
    const f = numOrNull(h.followers);
    out.push({
      platform,
      handle,
      url: socialUrl(platform, handle),
      followers: f !== null && Number.isInteger(f) && f >= 0 ? f : null,
      label: SELF_REPORTED_LABEL,
    });
  }
  return out;
}

export function projectPackage(raw: unknown): CreatorPackageView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== "ugc_video") return null;
  const priceCents = numOrNull(p.price_cents);
  if (!p.id || priceCents === null || !Number.isInteger(priceCents) || priceCents <= 0) return null;
  const addons = Array.isArray(p.addons)
    ? p.addons
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({ code: str(a.code), price_cents: numOrNull(a.price_cents) ?? 0 }))
        .filter((a) => a.code !== "")
    : [];
  return {
    id: str(p.id),
    kind: "ugc_video",
    title: str(p.title),
    description: strOrNull(p.description),
    currency: str(p.currency) || "usd",
    delivery_days: numOrNull(p.delivery_days) ?? 0,
    video_count: numOrNull(p.video_count),
    video_length_seconds: numOrNull(p.video_length_seconds),
    ad_rights_days: numOrNull(p.ad_rights_days),
    addons,
    pricing: feeBreakdown(priceCents),
  };
}

export function projectPackages(raw: unknown): CreatorPackageView[] {
  return (Array.isArray(raw) ? raw : [])
    .map(projectPackage)
    .filter((p): p is CreatorPackageView => p !== null);
}
