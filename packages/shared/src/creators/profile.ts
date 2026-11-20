
export const SELF_REPORTED_LABEL = "Self-reported, not checked by Zavi";

export type SelfReportedAudience = {
  platform: string;
  followers: number;
  self_reported: true;
};

export type SelfReportedMetrics = {
  self_reported: true;
  disclaimer: string;
  audience: SelfReportedAudience[];
};

export function buildSelfReportedMetrics(
  entries: Array<{ platform: string; followers: number }>,
): SelfReportedMetrics {
  return {
    self_reported: true,
    disclaimer: SELF_REPORTED_LABEL,
    audience: entries.map((e) => ({
      platform: e.platform,
      followers: e.followers,
      self_reported: true,
    })),
  };
}

export function readSelfReportedMetrics(raw: unknown): SelfReportedMetrics {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(obj.audience) ? obj.audience : [];
  const entries: Array<{ platform: string; followers: number }> = [];
  for (const item of list) {
    const e = (item ?? {}) as Record<string, unknown>;
    const platform = typeof e.platform === "string" ? e.platform : "";
    const followers = typeof e.followers === "number" ? e.followers : Number(e.followers);
    if (platform && Number.isFinite(followers) && followers >= 0) {
      entries.push({ platform, followers: Math.trunc(followers) });
    }
  }
  return buildSelfReportedMetrics(entries);
}

export const CREATOR_MIN_AGE_YEARS = 18;

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DobCheck =
  | { ok: true; date_of_birth: string }
  | { ok: false; code: "dob_missing" | "dob_invalid" | "under_18"; message: string };

export function ageInYears(dob: string, today: string): number {
  const [by, bm, bd] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

export function todayIsoUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function checkCreatorDob(raw: unknown, today: string = todayIsoUtc()): DobCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return { ok: false, code: "dob_missing", message: "Enter your date of birth." };
  }
  if (!ISO_DATE_PATTERN.test(value)) {
    return { ok: false, code: "dob_invalid", message: "Enter your date of birth as YYYY-MM-DD." };
  }
  const [y, m, d] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (
    asUtc.getUTCFullYear() !== y ||
    asUtc.getUTCMonth() !== m - 1 ||
    asUtc.getUTCDate() !== d ||
    y < 1900
  ) {
    return { ok: false, code: "dob_invalid", message: "That is not a real date." };
  }
  if (value > today) {
    return { ok: false, code: "dob_invalid", message: "That date is in the future." };
  }
  if (ageInYears(value, today) < CREATOR_MIN_AGE_YEARS) {
    return {
      ok: false,
      code: "under_18",
      message: `You have to be ${CREATOR_MIN_AGE_YEARS} or older to join Zavi as a creator.`,
    };
  }
  return { ok: true, date_of_birth: value };
}

export const CREATOR_INTRO_MAX_SECONDS = 30;
export const CREATOR_SAMPLE_VIDEOS_MAX = 3;

export const CREATOR_VIDEO_MIME = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type CreatorVideoMime = (typeof CREATOR_VIDEO_MIME)[number];

export const CREATOR_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export function videoExtensionFor(mime: string): string | null {
  switch (mime) {
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    default:
      return null;
  }
}

export const CREATOR_PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type CreatorPhotoMime = (typeof CREATOR_PHOTO_MIME)[number];
export const CREATOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export function isCreatorPhotoMime(mime: string): mime is CreatorPhotoMime {
  return (CREATOR_PHOTO_MIME as readonly string[]).includes(mime);
}

export function photoExtensionFor(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

export function isCreatorPhotoPath(path: string): boolean {
  return /\.(jpg|png|webp)$/.test(path);
}

export function isOwnMediaPath(path: string, authUserId: string): boolean {
  if (typeof path !== "string" || path.length < 3 || path.length > 400) return false;
  if (path.includes("..") || path.startsWith("/")) return false;
  if (!path.startsWith(`${authUserId}/`)) return false;
  return /^[A-Za-z0-9._-]+$/.test(path.slice(authUserId.length + 1));
}
