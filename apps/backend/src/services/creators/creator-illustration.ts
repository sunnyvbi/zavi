
import { createHash } from "node:crypto";
import { CREATOR_NICHES } from "@zavi/shared";
import { globalClient } from "@/services/tenant-client";
import { downloadMedia, generateMedia, isMediaRouterEnabled } from "@/services/media-router/router";
import type { MediaResult } from "@/services/media-router/types";
import { uploadCreatorImage } from "./creator-media";

const MEMBERS = "human_members";

export const RETRY_AFTER_MS = 60 * 60 * 1000;

const MAX_ILLUSTRATION_BYTES = 10 * 1024 * 1024;

const STYLES = [
  "flat vector illustration, soft pastel palette, gentle grain texture",
  "bold geometric illustration, warm sunset palette, clean shapes",
  "isometric 3D illustration, bright candy colors, soft shadows",
  "paper cut-out collage illustration, layered craft paper, muted earth tones",
  "risograph print style illustration, two-tone teal and coral",
  "minimal line art illustration with color blocks, cool blue and mint palette",
  "playful clay render, rounded shapes, cheerful saturated colors",
  "mid-century modern illustration, mustard, olive and cream palette",
] as const;

export function styleSeed(memberId: string, n: number = STYLES.length): number {
  const h = createHash("sha256").update(memberId).digest();
  return h.readUInt32BE(0) % n;
}

export function nicheLabelsFrom(skills: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of skills ?? []) {
    if (typeof raw !== "string") continue;
    const hit = CREATOR_NICHES.find((n) => n.toLowerCase() === raw.trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

export function buildIllustrationPrompt(memberId: string, skills: readonly string[] | null | undefined): string {
  const niches = nicheLabelsFrom(skills).slice(0, 3);
  const subject =
    niches.length > 0
      ? `a still-life scene of objects that evoke these themes: ${niches.map((n) => n.toLowerCase()).join(", ")}`
      : "a still-life scene of creative tools: a camera, a ring light and a notebook";
  const style = STYLES[styleSeed(memberId)];
  return [
    `Square avatar illustration, ${style}.`,
    `Subject: ${subject}, arranged in a simple centered composition on a plain background.`,
    "No people, no faces, no hands, no body parts, no text, no letters, no logos, no watermarks.",
  ].join(" ");
}

export type IllustrationMember = {
  id: string;
  auth_user_id: string | null;
  skills: string[] | null;
  vetting_state: string;
  photo_path: string | null;
  illustration_path: string | null;
  illustration_generated_at: string | null;
};

export type IllustrationOutcome =
  | "generated"
  | "not_found"
  | "not_live"
  | "has_photo"
  | "already_generated"
  | "no_fal_key"
  | "router_disabled"
  | "claim_lost"
  | "vendor_failed"
  | "download_failed"
  | "store_failed";

export type IllustrationDeps = {
  falKeyPresent: () => boolean;
  routerEnabled: () => Promise<boolean>;
  loadMember: (id: string) => Promise<IllustrationMember | null>;
  claim: (id: string, opts: { retryFailed: boolean; now: Date }) => Promise<boolean>;
  generate: (prompt: string) => Promise<MediaResult>;
  download: (url: string) => Promise<Uint8Array | null>;
  upload: (authUserId: string, bytes: Uint8Array, mime: string) => Promise<string>;
  save: (id: string, path: string) => Promise<boolean>;
  log: (msg: string) => void;
};

const sb = () => globalClient();

export const realIllustrationDeps: IllustrationDeps = {
  falKeyPresent: () => (process.env.FAL_KEY || "").trim().length > 0,
  routerEnabled: () => isMediaRouterEnabled(),
  async loadMember(id) {
    const { data, error } = await sb()
      .from(MEMBERS)
      .select("id, auth_user_id, skills, vetting_state, photo_path, illustration_path, illustration_generated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`human_members read failed: ${error.message}`);
    return (data as IllustrationMember | null) ?? null;
  },
  claim: (id, opts) => claimIllustration(sb().from(MEMBERS) as unknown as ClaimTable, id, opts),
  generate: (prompt) => generateMedia("image.photo", { prompt, aspect_ratio: "1:1" }),
  download: (url) => downloadMedia(url, MAX_ILLUSTRATION_BYTES),
  upload: (authUserId, bytes, mime) => uploadCreatorImage(authUserId, bytes, mime),
  async save(id, path) {
    const { data, error } = await sb()
      .from(MEMBERS)
      .update({ illustration_path: path, updated_at: new Date().toISOString() })
      .eq("id", id)
      .is("illustration_path", null)
      .select("id");
    if (error) throw new Error(`illustration save failed: ${error.message}`);
    return ((data as unknown[] | null) ?? []).length > 0;
  },
  log: (msg) => console.warn(`[creator-illustration] ${msg}`),
};

export type ClaimTable = {
  update: (v: Record<string, unknown>) => ClaimQuery;
};
export type ClaimQuery = {
  eq: (c: string, v: unknown) => ClaimQuery;
  is: (c: string, v: null) => ClaimQuery;
  or: (f: string) => ClaimQuery;
  select: (c: string) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};

export async function claimIllustration(
  table: ClaimTable,
  id: string,
  { retryFailed, now }: { retryFailed: boolean; now: Date },
): Promise<boolean> {
  let q = table
    .update({ illustration_generated_at: now.toISOString() })
    .eq("id", id)
    .is("photo_path", null)
    .is("illustration_path", null);
  if (retryFailed) {
    const cutoff = new Date(now.getTime() - RETRY_AFTER_MS).toISOString();
    q = q.or(`illustration_generated_at.is.null,illustration_generated_at.lt.${cutoff}`);
  } else {
    q = q.is("illustration_generated_at", null);
  }
  const { data, error } = await q.select("id");
  if (error) throw new Error(`illustration claim failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function generateCreatorIllustration(
  memberId: string,
  deps: IllustrationDeps = realIllustrationDeps,
  opts: { retryFailed?: boolean } = {},
): Promise<{ outcome: IllustrationOutcome; cost_usd?: number }> {
  const retryFailed = opts.retryFailed === true;
  const m = await deps.loadMember(memberId);
  if (!m || !m.auth_user_id) return { outcome: "not_found" };
  if (m.vetting_state !== "approved") return { outcome: "not_live" };
  if (m.photo_path) return { outcome: "has_photo" };
  if (m.illustration_path) return { outcome: "already_generated" };
  if (m.illustration_generated_at && !retryFailed) return { outcome: "already_generated" };
  if (!deps.falKeyPresent()) {
    deps.log(`skipped ${memberId}: FAL_KEY is not set, initials stay`);
    return { outcome: "no_fal_key" };
  }
  if (!(await deps.routerEnabled())) {
    deps.log(`skipped ${memberId}: media router is switched off, initials stay`);
    return { outcome: "router_disabled" };
  }
  if (!(await deps.claim(memberId, { retryFailed, now: new Date() }))) return { outcome: "claim_lost" };

  const r = await deps.generate(buildIllustrationPrompt(memberId, m.skills));
  if (!r.ok) {
    deps.log(`vendor failed for ${memberId}: ${r.reason}`);
    return { outcome: "vendor_failed" };
  }
  const bytes = await deps.download(r.url);
  if (!bytes) {
    deps.log(`download failed for ${memberId}`);
    return { outcome: "download_failed", cost_usd: r.cost_usd };
  }
  try {
    const path = await deps.upload(m.auth_user_id, bytes, r.mime ?? "image/png");
    if (!(await deps.save(memberId, path))) return { outcome: "already_generated", cost_usd: r.cost_usd };
  } catch (e) {
    deps.log(`store failed for ${memberId}: ${(e as Error).message}`);
    return { outcome: "store_failed", cost_usd: r.cost_usd };
  }
  return { outcome: "generated", cost_usd: r.cost_usd };
}
