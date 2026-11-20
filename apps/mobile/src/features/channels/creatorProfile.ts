import type { CreatorCard, CreatorPackage } from "./ugc";

export type Cover =
  | { kind: "photo"; url: string }
  | { kind: "illustration"; url: string }
  | { kind: "initials"; text: string };

export function coverOf(c: Pick<CreatorCard, "display_name" | "photo_url" | "illustration_url">): Cover {
  if (c.photo_url) return { kind: "photo", url: c.photo_url };
  if (c.illustration_url) return { kind: "illustration", url: c.illustration_url };
  return { kind: "initials", text: initials(c.display_name) };
}

export function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function ratingLine(r: { average: number | null; count: number }): { text: string; reviewed: boolean } {
  if (r.count > 0 && r.average !== null) {
    return { text: `${r.average} (${r.count} ${r.count === 1 ? "review" : "reviews"})`, reviewed: true };
  }
  return { text: "No reviews yet", reviewed: false };
}

export function compactCount(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const PLATFORM_NAME: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", linkedin: "LinkedIn" };
export const platformName = (p: string) => PLATFORM_NAME[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

const PLATFORM_CHANNEL: Record<string, string> = {
  tiktok: "tiktok_organic",
  instagram: "instagram_organic",
  youtube: "youtube_organic",
  x: "x_organic",
  linkedin: "linkedin_organic",
};
export const platformChannel = (p: string): string | null => PLATFORM_CHANNEL[p] ?? null;

export type HandleChip = { key: string; platform: string; text: string; url: string | null; hint: string };

export function handleChips(socials: CreatorCard["socials"]): HandleChip[] {
  return socials.map((s) => {
    const handle = s.platform === "linkedin" ? s.handle : `@${s.handle}`;
    const hint =
      s.followers !== null
        ? `${handle}: ${s.followers.toLocaleString("en-US")} followers on ${platformName(s.platform)}, self-reported`
        : `${handle} on ${platformName(s.platform)}`;
    return { key: `${s.platform}:${s.handle}`, platform: s.platform, text: s.followers !== null ? compactCount(s.followers) : handle, url: s.url, hint };
  });
}

export function followersNote(socials: CreatorCard["socials"]): string | null {
  const first = socials.find((s) => s.followers !== null);
  return first ? `Follower numbers: ${first.label}` : null;
}

export function laneWords(lanes: readonly string[]): string[] {
  return lanes.includes("ugc_video") ? ["UGC video"] : [];
}

export function metaLine(c: Pick<CreatorCard, "city" | "country_code" | "invited"> & { lanes?: string[] }): string {
  if (c.invited) return "";
  const place = [c.city, c.country_code].filter(Boolean).join(", ");
  return [place, ...laneWords(c.lanes ?? [])].filter(Boolean).join(" · ");
}

export function packagesHeading(pkgs: readonly Pick<CreatorPackage, "price_cents">[], money: (cents: number) => string): string {
  if (!pkgs.length) return "Packages";
  const from = Math.min(...pkgs.map((p) => p.price_cents));
  return `${pkgs.length} ${pkgs.length === 1 ? "package" : "packages"} · from ${money(from)}`;
}

export type TermsSource = Pick<CreatorPackage, "kind" | "delivery_days"> & {
  video_count?: number | null;
  video_length_seconds?: number | null;
  ad_rights_days?: number | null;
};

export function termsLine(p: TermsSource): string {
  const n = p.video_count ?? 1;
  const parts = [`${n} UGC ${n > 1 ? "videos" : "video"}`];
  if (p.video_length_seconds) parts.push(`${p.video_length_seconds}s`);
  if (p.ad_rights_days) parts.push(`ad rights ${p.ad_rights_days} days`);
  parts.push(`delivered in ${p.delivery_days} days`);
  parts.push("2 rounds of changes");
  return parts.join(" · ");
}
