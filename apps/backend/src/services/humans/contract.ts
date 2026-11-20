
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CREATOR_FOLLOWERS_MAX,
  CREATOR_LANES,
  CREATOR_SAMPLE_VIDEOS_MAX,
  PACKAGE_LIMITS,
  checkCreatorDob,
  checkCreatorPackage,
  isOwnMediaPath,
  isSocialPlatform,
  parseSocial,
  type CreatorLane,
} from "@zavi/shared";

export const DISCIPLINES = ["ugc_creator", "engineer", "designer", "support"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const OPEN_DISCIPLINES: ReadonlySet<Discipline> = new Set<Discipline>(["ugc_creator"]);

export const LANES = CREATOR_LANES;
export type Lane = CreatorLane;

export const OPEN_LANES: ReadonlySet<Lane> = new Set<Lane>(CREATOR_LANES);

export const RATE_UNITS = ["per_deliverable", "per_hour", "per_month"] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

export const HANDLE_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "github",
  "dribbble",
  "linkedin",
  "x",
  "other",
] as const;
export type HandlePlatform = (typeof HANDLE_PLATFORMS)[number];

export const VETTING_STATES = ["pending", "under_review", "approved", "rejected"] as const;
export type VettingState = (typeof VETTING_STATES)[number];

export const STAFF_SETTABLE_STATES = ["under_review", "approved", "rejected"] as const;
export type StaffSettableState = (typeof STAFF_SETTABLE_STATES)[number];

const handleSchema = z
  .object({
    platform: z.enum(HANDLE_PLATFORMS),
    handle: z.string().trim().min(1).max(300),
    followers: z.number().int().nonnegative().max(CREATOR_FOLLOWERS_MAX).optional(),
  })
  .superRefine((h, ctx) => {
    if (isSocialPlatform(h.platform)) {
      const r = parseSocial(h.platform, h.handle);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["handle"], message: r.message });
    } else if (h.handle.length > 80) {
      ctx.addIssue({ code: "custom", path: ["handle"], message: "That handle is too long." });
    }
  })
  .transform((h) => {
    if (!isSocialPlatform(h.platform)) return h;
    const r = parseSocial(h.platform, h.handle);
    return r.ok ? { ...h, handle: r.value.handle } : h;
  });

export const humanApplicationSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  discipline: z.enum(DISCIPLINES),
  skills: z.array(z.string().trim().min(1).max(60)).max(25).default([]),
  rate_usd: z.number().finite().nonnegative().max(1_000_000),
  rate_unit: z.enum(RATE_UNITS),
  handles: z.array(handleSchema).min(1).max(10),
  portfolio_urls: z.array(z.string().trim().url().max(2048)).max(25).default([]),
  screenshots: z.array(z.string().trim().min(1).max(512)).max(25).default([]),
  email: z.string().trim().email().max(320),
  legal_name: z.string().trim().min(1).max(200).optional(),
  bio: z.string().trim().min(1).max(2000).optional(),
  tin: z.string().trim().min(4).max(64).optional(),
  payout_ref: z.string().trim().min(4).max(128).optional(),

  lanes: z.array(z.enum(LANES)).min(1).max(LANES.length).optional(),

  date_of_birth: z
    .string()
    .superRefine((v, ctx) => {
      const check = checkCreatorDob(v);
      if (!check.ok) ctx.addIssue({ code: "custom", message: check.message });
    })
    .optional(),

  city: z.string().trim().min(1).max(120).optional(),
  country_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Pick your country.")
    .optional(),

  audience: z
    .array(
      z.object({
        platform: z.enum(HANDLE_PLATFORMS),
        followers: z.number().int().nonnegative().max(CREATOR_FOLLOWERS_MAX),
      }),
    )
    .max(10)
    .optional(),

  intro_video_path: z
    .string()
    .trim()
    .min(3)
    .max(400)
    .refine((v) => !v.includes("..") && !v.startsWith("/"), "Invalid media path.")
    .optional(),
  sample_video_paths: z
    .array(
      z
        .string()
        .trim()
        .min(3)
        .max(400)
        .refine((v) => !v.includes("..") && !v.startsWith("/"), "Invalid media path."),
    )
    .max(CREATOR_SAMPLE_VIDEOS_MAX)
    .optional(),

  packages: z
    .array(z.unknown())
    .min(1)
    .max(PACKAGE_LIMITS.packagesPerCreatorMax)
    .superRefine((list, ctx) => {
      list.forEach((entry, i) => {
        const check = checkCreatorPackage(entry);
        if (!check.ok) {
          ctx.addIssue({ code: "custom", path: [i, check.field], message: check.message });
        }
      });
    })
    .optional(),
});

export type HumanApplicationInput = z.infer<typeof humanApplicationSchema>;

export function assertOwnMedia(input: HumanApplicationInput, authUserId: string): void {
  const paths = [
    ...(input.intro_video_path ? [input.intro_video_path] : []),
    ...(input.sample_video_paths ?? []),
  ];
  for (const p of paths) {
    if (!isOwnMediaPath(p, authUserId)) {
      throw new HumanError("media_not_owned", "That video is not one you uploaded.", 403);
    }
  }
}

export function cleanHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim();
}

export function normalizeHandle(raw: string): string {
  return cleanHandle(raw).toLowerCase();
}

export function normalizeEmail(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0) return lowered;
  const local = lowered.slice(0, at);
  const domain = lowered.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return `${local}@${domain}`;
  const stripped = local.split("+")[0].replace(/\./g, "");
  return `${stripped || local}@${domain}`;
}

export function normalizeLegalName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.,'`-]/g, "").replace(/\s+/g, " ");
}

export function hashSecret(raw: string): string {
  const canonical = raw.trim().toLowerCase().replace(/[\s-]/g, "");
  return `\\x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type HumanErrorCode =
  | "validation"
  | "discipline_not_open"
  | "duplicate_handle"
  | "duplicate_email"
  | "duplicate_tin"
  | "duplicate_payout_ref"
  | "already_applied"
  | "not_found"
  | "not_rejected"
  | "reason_required"
  | "duplicate_slug"
  | "slug_reserved"
  | "lane_not_open"
  | "package_lane_mismatch"
  | "media_not_owned"
  | "under_18"
  | "human_store_error";

export class HumanError extends Error {
  constructor(
    readonly code: HumanErrorCode,
    message: string,
    readonly status: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HumanError";
  }
}

const UNIQUE_VIOLATION = "23505";

export function mapStoreError(error: { code?: string; message?: string; details?: string } | null): HumanError {
  const raw = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();
  if (error?.code === UNIQUE_VIOLATION) {
    if (raw.includes("slug")) {
      return new HumanError("duplicate_slug", "Could not save your profile just now. Try again.", 409);
    }
    if (raw.includes("handle")) {
      return new HumanError("duplicate_handle", "That handle is already registered on the human.", 409);
    }
    if (raw.includes("email")) {
      return new HumanError("duplicate_email", "That email is already registered on the human.", 409);
    }
    if (raw.includes("tin")) {
      return new HumanError("duplicate_tin", "That tax ID is already registered on the human.", 409);
    }
    if (raw.includes("payout")) {
      return new HumanError("duplicate_payout_ref", "That payout account is already registered on the human.", 409);
    }
    if (raw.includes("auth_user_id")) {
      return new HumanError("already_applied", "This account already has a human application.", 409);
    }
    return new HumanError("duplicate_handle", "Some of these details are already registered on the human.", 409);
  }
  return new HumanError("human_store_error", "Could not save the application. Try again.", 503);
}
