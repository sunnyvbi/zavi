
import { US_STATE_CODES } from "@/services/ad-locations/places";

export type Level = "world" | "country" | "region" | "city";
export type Canon = { level: Level; country?: string; region?: string; city?: string };

const STATE_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(US_STATE_CODES).map(([name, code]) => [code.toLowerCase(), name.toLowerCase()]));
const n = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export const placeName = n;
export const regionName = (s: string | null | undefined) => STATE_BY_CODE[n(s)] ?? n(s);

export function canonFromGoogle(canonical: string, kind: "Country" | "State" | "City" | "Region" | string): Canon | null {
  const parts = canonical.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const country = n(parts[parts.length - 1]);
  if (kind === "Country") return { level: "country", country };
  if (kind === "State") return { level: "region", country, region: regionName(parts[0]) };
  if (kind === "City") return { level: "city", country, city: n(parts[0]), ...(parts.length >= 3 ? { region: regionName(parts[parts.length - 2]) } : {}) };
  return null;
}

export function canonFromMetaSaved(name: string, kind: string): Canon | null {
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (kind === "Country") return { level: "country", country: n(parts[0]) };
  if (kind === "State") return { level: "region", region: regionName(parts[0]), ...(parts.length >= 2 ? { country: n(parts[parts.length - 1]) } : {}) };
  if (kind === "City") return { level: "city", city: n(parts[0]), ...(parts.length >= 2 ? { region: regionName(parts[1]) } : {}), ...(parts.length >= 3 ? { country: n(parts[2]) } : {}) };
  return null;
}

const DEPTH: Record<Level, number> = { world: 0, country: 1, region: 2, city: 3 };
const eq = (a?: string, b?: string): boolean | null => (a === undefined || b === undefined ? null : a === b);

export function inside(p: Canon, s: Canon): boolean | null {
  if (s.level === "world") return true;
  if (p.level === "world" || DEPTH[p.level] < DEPTH[s.level]) return false;
  const country = eq(p.country, s.country);
  if (country === false) return false;
  if (s.level === "country") return country;
  const region = eq(p.region, s.region);
  if (region === false) return false;
  if (s.level === "region") return region;
  if (eq(p.city, s.city) === false) return false;
  if (region === null) return null;
  return true;
}

export function overlaps(p: Canon, s: Canon): boolean | null {
  const a = inside(p, s);
  const b = inside(s, p);
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

export type PlaceVerdict = { ok: true } | { ok: false; why: "outside" | "blocked"; place?: Canon } | { ok: null };

export function judgePlace(p: Canon, allowed: readonly Canon[], blocked: readonly Canon[], unread: { allowed?: boolean; blocked?: boolean } = {}): PlaceVerdict {
  let unknown = unread.blocked === true;
  for (const b of blocked) {
    const o = overlaps(p, b);
    if (o === true) return { ok: false, why: "blocked", place: b };
    if (o === null) unknown = true;
  }
  if (allowed.length > 0) {
    const hits = allowed.map((a) => inside(p, a));
    if (hits.includes(true)) return unknown ? { ok: null } : { ok: true };
    if (hits.includes(null) || unread.allowed) return { ok: null };
    return { ok: false, why: "outside" };
  }
  return unknown || unread.allowed ? { ok: null } : { ok: true };
}

export function phraseIn(text: string, phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${words.join("\\s+")}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function canonLabel(c: Canon): string {
  const t = (s?: string) => (s ? s.replace(/\b\w/g, (m) => m.toUpperCase()) : "");
  if (c.level === "world") return "every country";
  return [t(c.city), t(c.region), t(c.country)].filter(Boolean).join(", ");
}
