import { CREATOR_NICHES as CREATOR_NICHES_LIST, businessPaysCents, creatorReceivesCents } from "@zavi/shared";

export type LanePlatform = "TikTok" | "Instagram" | "YouTube" | "X" | "LinkedIn";

export const DELIVERY_DAYS = [3, 5, 7, 14] as const;
export const UGC_LENGTHS = [15, 30, 60] as const;
export const DURATIONS = ["30 days", "90 days", "1 year"] as const;
export type Duration = (typeof DURATIONS)[number];
const DURATION_DAYS: Record<Duration, number> = { "30 days": 30, "90 days": 90, "1 year": 365 };

export const ROUNDS_LINE = "2 rounds of changes";

export type PackageSpec = {
  qty: number;
  deliveryDays: number;
  lengthSec: number;
  adRights: Duration;
  title: string;
  description: string;
  price: string;
};

export function defaultPackage(): PackageSpec {
  return { qty: 1, deliveryDays: 7, lengthSec: 30, adRights: "90 days", title: "", description: "", price: "" };
}

export function autoTitle(p: Pick<PackageSpec, "qty" | "lengthSec">): string {
  return `${p.qty} ${p.qty > 1 ? "UGC videos" : "UGC video"}, ${p.lengthSec}s`;
}

export function packageTitle(p: PackageSpec): string {
  return p.title.trim() || autoTitle(p);
}

export function packageTerms(p: PackageSpec): string {
  return `You send the files. The business posts them and can run them as ads for ${p.adRights}. Delivered in ${p.deliveryDays} days. ${ROUNDS_LINE}.`;
}

export function priceCents(price: string): number | null {
  const cleaned = price.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export function toPackagePayload(p: PackageSpec): Record<string, unknown> {
  return {
    kind: "ugc_video",
    title: packageTitle(p),
    description: p.description.trim() || undefined,
    price_cents: priceCents(p.price),
    delivery_days: p.deliveryDays,
    video_count: p.qty,
    video_length_seconds: p.lengthSec,
    ad_rights_days: DURATION_DAYS[p.adRights],
    addons: [],
  };
}

export type SavedPackage = {
  id: string;
  kind: "ugc_video";
  title: string;
  description: string | null;
  price_cents: number;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  active: boolean;
};

function daysToDuration(d: number | null): Duration {
  if (d === 30) return "30 days";
  if (d === 365) return "1 year";
  return "90 days";
}

export function specFromSaved(p: SavedPackage): PackageSpec {
  return {
    qty: p.video_count ?? 1,
    deliveryDays: p.delivery_days,
    lengthSec: p.video_length_seconds ?? 30,
    adRights: daysToDuration(p.ad_rights_days),
    title: p.title,
    description: p.description ?? "",
    price: String(p.price_cents / 100),
  };
}

export function money(dollars: number): string {
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: dollars % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function creatorGets(dollars: number): number {
  return creatorReceivesCents(Math.round(dollars * 100)) / 100;
}

export function businessTotal(dollars: number): number {
  return businessPaysCents(Math.round(dollars * 100)) / 100;
}

export const PAYOUT_REGIONS_LINE = "Zavi can pay creators in the US, Canada, the UK, the EEA and Switzerland";

const SUPPORTED: [string, string][] = [
  ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["CH", "Switzerland"],
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"],
  ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"],
  ["DE", "Germany"], ["GR", "Greece"], ["HU", "Hungary"], ["IS", "Iceland"], ["IE", "Ireland"],
  ["IT", "Italy"], ["LV", "Latvia"], ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MT", "Malta"], ["NL", "Netherlands"], ["NO", "Norway"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RO", "Romania"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"],
];
const OTHER: [string, string][] = [
  ["AU", "Australia"], ["BR", "Brazil"], ["IN", "India"], ["MX", "Mexico"], ["NG", "Nigeria"],
  ["PH", "Philippines"], ["ZA", "South Africa"],
];

export const COUNTRIES = [...SUPPORTED, ...OTHER]
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const PAYABLE_COUNTRIES = COUNTRIES.filter((c) => SUPPORTED.some(([code]) => code === c.code));

export function countryName(code: string | null | undefined): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code ?? "";
}

export function canPay(code: string | null | undefined): boolean {
  return SUPPORTED.some(([c]) => c === code);
}

export const LANE_PLATFORMS: LanePlatform[] = ["TikTok", "Instagram", "YouTube", "X", "LinkedIn"];
export const SELF_REPORTED = "Self-reported, not checked by Zavi";

export const PLATFORM_KEY: Record<LanePlatform, string> = {
  TikTok: "tiktok",
  Instagram: "instagram",
  YouTube: "youtube",
  X: "x",
  LinkedIn: "linkedin",
};
export function platformFromKey(k: string): LanePlatform | null {
  return (Object.keys(PLATFORM_KEY) as LanePlatform[]).find((p) => PLATFORM_KEY[p] === k) ?? null;
}

export const SOCIAL_PLACEHOLDER: Record<LanePlatform, string> = {
  TikTok: "tiktok.com/@mayafilms or @mayafilms",
  Instagram: "instagram.com/maya.films or @maya.films",
  YouTube: "youtube.com/@leomakes or @leomakes",
  X: "x.com/leomakes or @leomakes",
  LinkedIn: "linkedin.com/in/priya-talks or priya-talks",
};
const HOST: Record<LanePlatform, [string, string]> = {
  TikTok: ["tiktok.com", "@"],
  Instagram: ["instagram.com", ""],
  YouTube: ["youtube.com", "@"],
  X: ["x.com", ""],
  LinkedIn: ["linkedin.com", "in/"],
};
export function socialLinkText(p: LanePlatform, handle: string): string {
  return `${HOST[p][0]}/${HOST[p][1]}${handle}`;
}
export function socialError(p: LanePlatform): string {
  return `That doesn't look like a ${p} profile`;
}

export { CREATOR_NICHES } from "@zavi/shared";

export function nicheLabel(raw: string): string {
  const t = raw.trim();
  const hit = CREATOR_NICHES_LIST.find((c) => c.toLowerCase() === t.toLowerCase());
  return hit ?? t.charAt(0).toUpperCase() + t.slice(1);
}
