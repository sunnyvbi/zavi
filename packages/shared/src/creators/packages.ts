
import { CREATOR_CURRENCY, creatorFeeCents, creatorReceivesCents } from "./fees";

export const CREATOR_PACKAGE_KINDS = ["ugc_video"] as const;
export type CreatorPackageKind = (typeof CREATOR_PACKAGE_KINDS)[number];

export const CREATOR_LANES = ["ugc_video"] as const;
export type CreatorLane = (typeof CREATOR_LANES)[number];

export const CREATOR_LANE_LABELS: Record<CreatorLane, string> = {
  ugc_video: "Videos for brands' ads",
};

export const AD_RIGHTS_DAYS = [30, 90, 365] as const;
export type AdRightsDays = (typeof AD_RIGHTS_DAYS)[number];

export const PACKAGE_ADDON_CODES = ["partnership_ad_code", "raw_footage", "extra_hook"] as const;
export type PackageAddonCode = (typeof PACKAGE_ADDON_CODES)[number];

export const PACKAGE_ADDON_LABELS: Record<PackageAddonCode, string> = {
  partnership_ad_code: "Partnership ad code",
  raw_footage: "Raw footage",
  extra_hook: "Extra hook",
};

export const PACKAGE_LIMITS = {
  titleMax: 120,
  descriptionMax: 2000,
  priceCentsMin: 1,
  priceCentsMax: 10_000_000,
  deliveryDaysMin: 1,
  deliveryDaysMax: 90,
  videoCountMin: 1,
  videoCountMax: 20,
  videoLengthSecondsMin: 5,
  videoLengthSecondsMax: 600,
  addonsMax: 3,
  packagesPerCreatorMax: 12,
} as const;

export type PackageAddon = { code: PackageAddonCode; price_cents: number };

export type UgcVideoPackage = {
  kind: "ugc_video";
  title: string;
  description?: string;
  price_cents: number;
  delivery_days: number;
  video_count: number;
  video_length_seconds: number;
  ad_rights_days: AdRightsDays;
  addons: PackageAddon[];
};

export type CreatorPackage = UgcVideoPackage;

export type PackageCheck =
  | { ok: true; value: CreatorPackage }
  | { ok: false; field: string; message: string };

function bad(field: string, message: string): PackageCheck {
  return { ok: false, field, message };
}

function asInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function checkCommon(raw: Record<string, unknown>): PackageCheck | null {
  const title = asText(raw.title);
  if (!title) return bad("title", "Give the package a name.");
  if (title.length > PACKAGE_LIMITS.titleMax) {
    return bad("title", `Keep the name under ${PACKAGE_LIMITS.titleMax} characters.`);
  }
  const description = asText(raw.description);
  if (description.length > PACKAGE_LIMITS.descriptionMax) {
    return bad("description", `Keep the description under ${PACKAGE_LIMITS.descriptionMax} characters.`);
  }
  const price = asInt(raw.price_cents);
  if (price === null || price < PACKAGE_LIMITS.priceCentsMin) {
    return bad("price_cents", "Set a price above $0.");
  }
  if (price > PACKAGE_LIMITS.priceCentsMax) {
    return bad("price_cents", "That price is higher than Zavi can take. Keep it under $100,000.");
  }
  const days = asInt(raw.delivery_days);
  if (days === null || days < PACKAGE_LIMITS.deliveryDaysMin || days > PACKAGE_LIMITS.deliveryDaysMax) {
    return bad(
      "delivery_days",
      `Say how many days you need, between ${PACKAGE_LIMITS.deliveryDaysMin} and ${PACKAGE_LIMITS.deliveryDaysMax}.`,
    );
  }
  return null;
}

function checkAddons(raw: unknown): { ok: true; addons: PackageAddon[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, addons: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "Add-ons must be a list." };
  if (raw.length > PACKAGE_LIMITS.addonsMax) {
    return { ok: false, message: `At most ${PACKAGE_LIMITS.addonsMax} add-ons.` };
  }
  const seen = new Set<string>();
  const addons: PackageAddon[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const code = asText(e.code) as PackageAddonCode;
    if (!(PACKAGE_ADDON_CODES as readonly string[]).includes(code)) {
      return { ok: false, message: "That add-on is not one Zavi offers." };
    }
    if (seen.has(code)) return { ok: false, message: "Each add-on can only be priced once." };
    seen.add(code);
    const price = asInt(e.price_cents);
    if (price === null || price < PACKAGE_LIMITS.priceCentsMin || price > PACKAGE_LIMITS.priceCentsMax) {
      return { ok: false, message: `Set a price above $0 for ${PACKAGE_ADDON_LABELS[code]}.` };
    }
    addons.push({ code, price_cents: price });
  }
  return { ok: true, addons };
}

export function checkCreatorPackage(input: unknown): PackageCheck {
  const raw = (input ?? {}) as Record<string, unknown>;
  const kind = asText(raw.kind);
  if (!(CREATOR_PACKAGE_KINDS as readonly string[]).includes(kind)) {
    return bad("kind", "Pick one of Zavi's package templates.");
  }
  const common = checkCommon(raw);
  if (common) return common;

  const base = {
    title: asText(raw.title),
    ...(asText(raw.description) ? { description: asText(raw.description) } : {}),
    price_cents: asInt(raw.price_cents)!,
    delivery_days: asInt(raw.delivery_days)!,
  };

  const videoCount = asInt(raw.video_count);
  if (
    videoCount === null ||
    videoCount < PACKAGE_LIMITS.videoCountMin ||
    videoCount > PACKAGE_LIMITS.videoCountMax
  ) {
    return bad("video_count", `Say how many videos, between ${PACKAGE_LIMITS.videoCountMin} and ${PACKAGE_LIMITS.videoCountMax}.`);
  }
  const length = asInt(raw.video_length_seconds);
  if (
    length === null ||
    length < PACKAGE_LIMITS.videoLengthSecondsMin ||
    length > PACKAGE_LIMITS.videoLengthSecondsMax
  ) {
    return bad(
      "video_length_seconds",
      `Say how long each video is, between ${PACKAGE_LIMITS.videoLengthSecondsMin} and ${PACKAGE_LIMITS.videoLengthSecondsMax} seconds.`,
    );
  }
  const rights = asInt(raw.ad_rights_days);
  if (rights === null || !(AD_RIGHTS_DAYS as readonly number[]).includes(rights)) {
    return bad("ad_rights_days", "Pick 30, 90 or 365 days of ad rights.");
  }
  const addons = checkAddons(raw.addons);
  if (!addons.ok) return bad("addons", addons.message);
  return {
    ok: true,
    value: {
      kind: "ugc_video",
      ...base,
      video_count: videoCount,
      video_length_seconds: length,
      ad_rights_days: rights as AdRightsDays,
      addons: addons.addons,
    },
  };
}

export function packageLane(pkg: CreatorPackage): CreatorLane {
  return pkg.kind;
}

export type PackageFeeLine = {
  price_cents: number;
  creator_fee_cents: number;
  creator_receives_cents: number;
  currency: string;
};

export function packageFeeLine(priceCents: number): PackageFeeLine {
  return {
    price_cents: priceCents,
    creator_fee_cents: creatorFeeCents(priceCents),
    creator_receives_cents: creatorReceivesCents(priceCents),
    currency: CREATOR_CURRENCY,
  };
}
