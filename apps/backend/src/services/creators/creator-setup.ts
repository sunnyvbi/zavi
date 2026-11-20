
import { globalClient, selfAccountClient } from "@/services/tenant-client";
import {
  checkCreatorDob,
  checkCreatorPackage,
  CREATOR_NICHES,
  isCreatorPhotoPath,
  isOwnMediaPath,
  isSocialPlatform,
  parseSocial,
  type CreatorPackage,
} from "@zavi/shared";
import { swapMemberHandles, writeWithFreshSlug } from "@/services/humans/store";
import { HumanError, mapStoreError } from "@/services/humans/contract";
import { inngest } from "@/../workers/client";
import { notify } from "./notify";
import { codeFor } from "@/services/affiliates/store";
import { webBaseUrl } from "@/services/web-base";
import { adoptUploadedPhoto, discardUpload, signCreatorMedia, type AdoptResult } from "./creator-media";

const MEMBERS = "human_members";
const HANDLES = "human_member_handles";
const PII = "human_member_pii";
const PACKAGES = "creator_packages";

export { CREATOR_NICHES };

export const CREATOR_ACCOUNT_PLATFORMS = ["tiktok", "instagram", "youtube", "x", "linkedin"] as const;
export type CreatorAccountPlatform = (typeof CREATOR_ACCOUNT_PLATFORMS)[number];

export class CreatorSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "CreatorSetupError";
  }
}

function fail(error: { code?: string; message?: string; details?: string } | null): never {
  throw mapStoreError(error);
}

export const EARN_MODES = ["affiliate", "jobs", "both"] as const;
export type EarnMode = (typeof EARN_MODES)[number];

export function readEarnMode(raw: unknown): EarnMode | null {
  return typeof raw === "string" && (EARN_MODES as readonly string[]).includes(raw) ? (raw as EarnMode) : null;
}

export function packageRequired(mode: EarnMode | null | undefined): boolean {
  return mode !== "affiliate";
}

export type SetupFacts = {
  has_dob: boolean;
  account_count: number;
  niche_count: number;
  active_package_count: number;
  earn_mode?: EarnMode | null;
};

export type SetupStatus = {
  goal: boolean;
  earn_mode: EarnMode | null;
  dob: boolean;
  make: boolean;
  package: boolean;
  package_required: boolean;
  done: number;
  total: number;
  complete: boolean;
};

export function setupStatus(f: SetupFacts): SetupStatus {
  const earn_mode = readEarnMode(f.earn_mode);
  const goal = earn_mode !== null;
  const dob = f.has_dob;
  const make = f.account_count > 0 && f.niche_count > 0;
  const pkg = f.active_package_count > 0;
  const needsPackage = packageRequired(earn_mode);
  const steps = [goal, dob, make, ...(needsPackage ? [pkg] : [])];
  const complete = dob && make && (needsPackage ? pkg : true);
  return {
    goal,
    earn_mode,
    dob,
    make,
    package: pkg,
    package_required: needsPackage,
    done: steps.filter(Boolean).length,
    total: steps.length,
    complete,
  };
}

export function parseEarnMode(raw: unknown): EarnMode {
  const b = (raw ?? {}) as Record<string, unknown>;
  const affiliate = b.affiliate === true;
  const jobs = b.jobs === true;
  if (affiliate && jobs) return "both";
  if (affiliate) return "affiliate";
  if (jobs) return "jobs";
  throw new CreatorSetupError("validation", "Pick at least one.");
}

export function autoApproveTarget(vetting_state: string, status: SetupStatus): "approved" | null {
  return vetting_state === "pending" && status.complete ? "approved" : null;
}

export type AccountInput = { platform: string; handle: string; followers: number | string };
export type ParsedAccount = { platform: CreatorAccountPlatform; handle: string; followers: number };

export function parseAccounts(raw: unknown): ParsedAccount[] {
  if (!Array.isArray(raw)) throw new CreatorSetupError("validation", "Add your accounts.");
  if (raw.length > CREATOR_ACCOUNT_PLATFORMS.length) {
    throw new CreatorSetupError("validation", "One account per platform.");
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const platform = typeof e.platform === "string" ? e.platform.trim().toLowerCase() : "";
    if (!isSocialPlatform(platform)) {
      throw new CreatorSetupError("validation", "Pick TikTok, Instagram, YouTube, X or LinkedIn.");
    }
    if (seen.has(platform)) throw new CreatorSetupError("validation", "One account per platform.");
    seen.add(platform);
    const parsed = parseSocial(platform, typeof e.handle === "string" ? e.handle : "");
    if (!parsed.ok) throw new CreatorSetupError("validation", parsed.message);
    const followers = Number(String(e.followers ?? "").replace(/[^0-9]/g, ""));
    if (!Number.isInteger(followers) || followers <= 0 || followers > 1_000_000_000) {
      throw new CreatorSetupError("validation", "Add a follower number for each platform you picked.");
    }
    return { platform, handle: parsed.value.handle, followers };
  });
}

export function parseNiches(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CreatorSetupError("validation", "Pick at least one niche.");
  }
  const allowed = new Set<string>(CREATOR_NICHES);
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== "string" || !allowed.has(n)) {
      throw new CreatorSetupError("validation", "Pick your niches from the list.");
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function parsePackage(raw: unknown): CreatorPackage {
  const check = checkCreatorPackage(raw);
  if (!check.ok) throw new CreatorSetupError("validation", check.message);
  return check.value;
}

export function packageRow(memberId: string, p: CreatorPackage): Record<string, unknown> {
  return {
    human_member_id: memberId,
    kind: p.kind,
    title: p.title,
    description: p.description ?? null,
    price_cents: p.price_cents,
    currency: "usd",
    delivery_days: p.delivery_days,
    video_count: p.video_count,
    video_length_seconds: p.video_length_seconds,
    ad_rights_days: p.ad_rights_days,
    addons: p.addons,
    ad_label_required: false,
    active: true,
  };
}

function isCreatorVideoPath(path: string): boolean {
  return /\.(mp4|mov|webm)$/.test(path);
}

export type ProfilePatch = {
  display_name?: string;
  bio?: string | null;
  intro_video_path?: string | null;
  photo_path?: string | null;
  country_code?: string;
};

export function parseProfilePatch(raw: unknown, authUserId: string): ProfilePatch {
  const body = (raw ?? {}) as Record<string, unknown>;
  const patch: ProfilePatch = {};
  if (body.display_name !== undefined) patch.display_name = parseDisplayName(body.display_name);
  if (body.bio !== undefined) {
    const bio = typeof body.bio === "string" ? body.bio.trim() : "";
    if (bio.length > 2000) throw new CreatorSetupError("validation", "Keep your bio under 2,000 characters.");
    patch.bio = bio || null;
  }
  if (body.intro_video_path !== undefined) {
    if (body.intro_video_path === null) {
      patch.intro_video_path = null;
    } else {
      const p = typeof body.intro_video_path === "string" ? body.intro_video_path.trim() : "";
      if (!p || p.includes("..") || !isOwnMediaPath(p, authUserId)) {
        throw new CreatorSetupError("media_not_owned", "That video is not one you uploaded.", 403);
      }
      if (!isCreatorVideoPath(p)) {
        throw new CreatorSetupError("unsupported_media_type", "Upload an MP4, MOV or WebM video.");
      }
      patch.intro_video_path = p;
    }
  }
  if (body.photo_path !== undefined) {
    if (body.photo_path === null) {
      patch.photo_path = null;
    } else {
      const p = typeof body.photo_path === "string" ? body.photo_path.trim() : "";
      if (!p || p.includes("..") || !isOwnMediaPath(p, authUserId)) {
        throw new CreatorSetupError("media_not_owned", "That photo is not one you uploaded.", 403);
      }
      if (!isCreatorPhotoPath(p)) {
        throw new CreatorSetupError("unsupported_media_type", "Upload a JPG, PNG or WebP photo.");
      }
      patch.photo_path = p;
    }
  }
  if (body.country_code !== undefined) {
    const c = typeof body.country_code === "string" ? body.country_code.trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(c)) throw new CreatorSetupError("validation", "Pick your country.");
    patch.country_code = c;
  }
  if (Object.keys(patch).length === 0) throw new CreatorSetupError("validation", "Nothing to change.");
  return patch;
}

export function parseDisplayName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new CreatorSetupError("validation", "Add your name.");
  if (name.length > 120) throw new CreatorSetupError("validation", "Keep your name under 120 characters.");
  return name;
}

export const MIN_CREATOR_AGE = 18;
export const MAX_CREATOR_AGE = 120;

export function parseAge(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n > MAX_CREATOR_AGE || n < 1) {
    throw new CreatorSetupError("validation", "Pick your age.");
  }
  if (n < MIN_CREATOR_AGE) throw new CreatorSetupError("under_18", "You need to be 18 or older to sell on Zavi.");
  return n;
}

export function parseDob(raw: unknown): string {
  const check = checkCreatorDob(raw);
  if (!check.ok) throw new CreatorSetupError(check.code, check.message);
  return check.date_of_birth;
}

const sb = () => globalClient();

export type CreatorProfileRow = {
  bio: string | null;
  intro_video_path: string | null;
  photo_path?: string | null;
  illustration_path?: string | null;
  country_code: string | null;
  skills: string[] | null;
  vetting_state: string;
};

export type CreatorAccountRow = { platform: string; handle: string; followers: number | null };

export type AccountHome = {
  home: "/workspace" | "/creator" | "/start";
  has_company: boolean;
  in_any_company: boolean;
  is_creator: boolean;
};

export function decideHome(f: { active_tenant: boolean; member_of_tenant: boolean; is_creator: boolean }): AccountHome {
  const home = f.active_tenant
    ? "/workspace"
    : f.member_of_tenant
      ? "/start"
      : f.is_creator
        ? "/creator"
        : "/start";
  return { home, has_company: f.active_tenant, in_any_company: f.active_tenant || f.member_of_tenant, is_creator: f.is_creator };
}

export const setupStore = {
  async accountFacts(authUserId: string): Promise<{ active_tenant: boolean; member_of_tenant: boolean; is_creator: boolean }> {
    const own = selfAccountClient("creator home: where does this verified user belong (own rows only)");
    const [profile, membership, member] = await Promise.all([
      own.from("profiles").select("active_tenant_id").eq("user_id", authUserId).maybeSingle(),
      own.from("tenant_users").select("tenant_id").eq("user_id", authUserId).limit(1),
      sb().from(MEMBERS).select("id").eq("auth_user_id", authUserId).maybeSingle(),
    ]);
    for (const r of [profile, membership, member]) if (r.error) fail(r.error);
    return {
      active_tenant: !!(profile.data as { active_tenant_id?: string | null } | null)?.active_tenant_id,
      member_of_tenant: ((membership.data as unknown[] | null) ?? []).length > 0,
      is_creator: !!member.data,
    };
  },

  async createAccount(authUserId: string, displayName: string, email: string): Promise<{ id: string; created: boolean }> {
    const existing = await sb().from(MEMBERS).select("id").eq("auth_user_id", authUserId).maybeSingle();
    if (existing.error) fail(existing.error);
    if (existing.data) {
      const id = (existing.data as { id: string }).id;
      const pii = await sb()
        .from(PII)
        .upsert({ human_member_id: id, email: email.trim() }, { onConflict: "human_member_id", ignoreDuplicates: true });
      if (pii.error) fail(pii.error);
      return { id, created: false };
    }

    const data = await writeWithFreshSlug(displayName, (slug) =>
      sb()
        .from(MEMBERS)
        .insert({
          auth_user_id: authUserId,
          display_name: displayName,
          discipline: "ugc_creator",
          slug,
          vetting_state: "pending",
        })
        .select("id")
        .single(),
    );
    const id = (data as { id: string }).id;
    const pii = await sb().from(PII).insert({ human_member_id: id, email: email.trim() });
    if (pii.error) {
      await sb().from(MEMBERS).delete().eq("id", id);
      fail(pii.error);
    }
    return { id, created: true };
  },

  async facts(memberId: string): Promise<SetupFacts & { vetting_state: string; country_code?: string | null }> {
    const readMember = async () => {
      const r = await sb().from(MEMBERS).select("skills, vetting_state, country_code, earn_mode").eq("id", memberId).maybeSingle();
      if (r.error && (r.error.code === "42703" || r.error.code === "PGRST204" || /column .* does not exist/i.test(r.error.message ?? ""))) {
        return sb().from(MEMBERS).select("skills, vetting_state, country_code").eq("id", memberId).maybeSingle();
      }
      return r;
    };
    const [member, pii, handles, pkgs] = await Promise.all([
      readMember(),
      sb().from(PII).select("date_of_birth, age_years").eq("human_member_id", memberId).maybeSingle(),
      sb().from(HANDLES).select("id").eq("human_member_id", memberId),
      sb().from(PACKAGES).select("id").eq("human_member_id", memberId).eq("active", true),
    ]);
    for (const r of [member, pii, handles, pkgs]) if (r.error) fail(r.error);
    const m = (member.data ?? {}) as { skills?: string[] | null; vetting_state?: string; country_code?: string | null; earn_mode?: string | null };
    return {
      has_dob: Boolean(
        (pii.data as { date_of_birth?: string | null } | null)?.date_of_birth ||
          (pii.data as { age_years?: number | null } | null)?.age_years,
      ),
      account_count: ((handles.data as unknown[] | null) ?? []).length,
      niche_count: (m.skills ?? []).length,
      active_package_count: ((pkgs.data as unknown[] | null) ?? []).length,
      earn_mode: readEarnMode(m.earn_mode),
      vetting_state: m.vetting_state ?? "pending",
      country_code: m.country_code ?? null,
    };
  },

  async ownAge(memberId: string): Promise<number | null> {
    const { data, error } = await sb().from(PII).select("age_years").eq("human_member_id", memberId).maybeSingle();
    if (error) fail(error);
    const age = (data as { age_years?: number | null } | null)?.age_years;
    return typeof age === "number" ? age : null;
  },

  async saveDob(memberId: string, dob: string, email: string | null = null): Promise<void> {
    const { data, error } = await sb()
      .from(PII)
      .update({ date_of_birth: dob, updated_at: new Date().toISOString() })
      .eq("human_member_id", memberId)
      .select("human_member_id");
    if (error) fail(error);
    if (((data as unknown[] | null) ?? []).length > 0) return;
    if (email) {
      const ins = await sb().from(PII).insert({ human_member_id: memberId, email: email.trim(), date_of_birth: dob });
      if (ins.error) fail(ins.error);
      return;
    }
    throw new CreatorSetupError("not_saved", "Your date of birth did not save. Try again.", 409);
  },

  async saveAge(memberId: string, age: number, email: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await sb()
      .from(PII)
      .update({ age_years: age, age_confirmed_at: now, updated_at: now })
      .eq("human_member_id", memberId)
      .select("human_member_id");
    if (error) fail(error);
    if (((data as unknown[] | null) ?? []).length > 0) return;
    if (email) {
      const ins = await sb().from(PII).insert({ human_member_id: memberId, email: email.trim(), age_years: age, age_confirmed_at: now });
      if (ins.error) fail(ins.error);
      return;
    }
    throw new CreatorSetupError("not_saved", "Your age did not save. Try again.", 409);
  },

  async saveAccounts(memberId: string, accounts: ParsedAccount[]): Promise<void> {
    await swapMemberHandles(
      memberId,
      accounts.map((a) => ({ platform: a.platform, handle: a.handle, followers: a.followers })),
    );
  },

  async saveEarnMode(memberId: string, mode: EarnMode): Promise<void> {
    const { error } = await sb()
      .from(MEMBERS)
      .update({ earn_mode: mode, updated_at: new Date().toISOString() })
      .eq("id", memberId);
    if (error) fail(error);
  },

  async saveNiches(memberId: string, niches: string[]): Promise<void> {
    const { error } = await sb()
      .from(MEMBERS)
      .update({ skills: niches, updated_at: new Date().toISOString() })
      .eq("id", memberId);
    if (error) fail(error);
  },

  async addPackage(memberId: string, p: CreatorPackage): Promise<void> {
    const ins = await sb().from(PACKAGES).insert(packageRow(memberId, p)).select("id").single();
    if (ins.error) fail(ins.error);
    const pkgId = (ins.data as { id: string }).id;
    try {
      const cur = await sb().from(MEMBERS).select("lanes").eq("id", memberId).maybeSingle();
      if (cur.error) fail(cur.error);
      const lanes = ((cur.data as { lanes?: string[] | null } | null)?.lanes ?? []).slice();
      if (!lanes.includes(p.kind)) {
        lanes.push(p.kind);
        const up = await sb().from(MEMBERS).update({ lanes }).eq("id", memberId);
        if (up.error) fail(up.error);
      }
    } catch (e) {
      const undo = await sb().from(PACKAGES).delete().eq("id", pkgId).eq("human_member_id", memberId);
      if (undo.error) fail(undo.error);
      throw e;
    }
  },

  async payoutAccountCountry(memberId: string): Promise<string | null> {
    const { data, error } = await globalClient()
      .from("creator_payout_accounts")
      .select("country")
      .eq("human_member_id", memberId)
      .limit(1);
    if (error) fail(error);
    const row = ((data ?? []) as { country: string | null }[])[0];
    return row?.country ? row.country.toUpperCase() : null;
  },

  async syncEmail(memberId: string, email: string): Promise<boolean> {
    const next = email.trim();
    if (!next) return false;
    const { data, error } = await sb().from(PII).select("email").eq("human_member_id", memberId).maybeSingle();
    if (error) fail(error);
    const current = ((data as { email?: string | null } | null)?.email ?? "").trim();
    if (!data || current.toLowerCase() === next.toLowerCase()) return false;
    const up = await sb().from(PII).update({ email: next, updated_at: new Date().toISOString() }).eq("human_member_id", memberId);
    if (up.error) fail(up.error);
    return true;
  },

  async updateProfile(memberId: string, patch: ProfilePatch): Promise<void> {
    const { error } = await sb()
      .from(MEMBERS)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", memberId);
    if (error) fail(error);
  },

  adoptPhoto(authUserId: string, uploadPath: string): Promise<AdoptResult> {
    return adoptUploadedPhoto(authUserId, uploadPath);
  },

  discardUpload(authUserId: string, uploadPath: string): Promise<void> {
    return discardUpload(authUserId, uploadPath);
  },

  signMedia(path: string | null | undefined, authUserId: string): Promise<string | null> {
    return signCreatorMedia(path, authUserId);
  },

  async setApproved(memberId: string): Promise<boolean> {
    const { data, error } = await sb()
      .from(MEMBERS)
      .update({ vetting_state: "approved", updated_at: new Date().toISOString() })
      .eq("id", memberId)
      .eq("vetting_state", "pending")
      .select("id");
    if (error) fail(error);
    return ((data as unknown[] | null) ?? []).length > 0;
  },

  async profile(memberId: string): Promise<{ profile: CreatorProfileRow; accounts: CreatorAccountRow[] }> {
    const base = "bio, intro_video_path, country_code, skills, vetting_state";
    const readMember = async () => {
      const r = await sb().from(MEMBERS).select(`${base}, photo_path, illustration_path`).eq("id", memberId).maybeSingle();
      if (r.error && (r.error.code === "42703" || /column .* does not exist/i.test(r.error.message ?? ""))) {
        return sb().from(MEMBERS).select(base).eq("id", memberId).maybeSingle();
      }
      return r;
    };
    const [member, handles] = await Promise.all([
      readMember(),
      sb().from(HANDLES).select("*").eq("human_member_id", memberId),
    ]);
    if (member.error) fail(member.error);
    if (handles.error) fail(handles.error);
    const rows = ((handles.data as Array<Record<string, unknown>> | null) ?? []).map((h) => ({
      platform: String(h.platform ?? ""),
      handle: String(h.handle ?? ""),
      followers: typeof h.followers === "number" ? h.followers : null,
    }));
    return {
      profile: (member.data as CreatorProfileRow | null) ?? {
        bio: null,
        intro_video_path: null,
        country_code: null,
        skills: [],
        vetting_state: "pending",
      },
      accounts: rows.filter((r) => isSocialPlatform(r.platform)),
    };
  },
};

export type SetupStore = typeof setupStore;

export async function sendCreatorLive(memberId: string, countryMissing: boolean, earnMode: EarnMode | null = null): Promise<void> {
  const affiliateOnly = earnMode === "affiliate";
  let affiliateLink: string | null = null;
  if (earnMode === "affiliate" || earnMode === "both") {
    try {
      affiliateLink = `${webBaseUrl()}/?via=${await codeFor(memberId)}`;
    } catch (e) {
      console.warn(`[creator-setup] affiliate link not read: ${(e as Error).message}`);
    }
  }
  try {
    await notify({
      recipient: { kind: "creator", human_member_id: memberId },
      event: "creator_live",
      scope_id: memberId,
      vars: affiliateOnly
        ? { affiliate_only: true, affiliate_link: affiliateLink, link_path: "/creator/affiliate" }
        : { country_missing: countryMissing, ...(affiliateLink ? { affiliate_link: affiliateLink } : {}) },
    });
  } catch (e) {
    console.warn(`[creator-setup] live email failed: ${(e as Error).message}`);
  }
  try {
    await inngest.send({
      id: `creator-illustration-${memberId}`,
      name: "creator/illustration.generate",
      data: { human_member_id: memberId },
    });
  } catch (e) {
    console.warn(`[creator-setup] illustration not queued: ${(e as Error).message}`);
  }
  if (!countryMissing || affiliateOnly) return;
  try {
    await inngest.send({ name: "creator/setup.country_check", data: { human_member_id: memberId } });
  } catch (e) {
    console.warn(`[creator-setup] country reminder not armed: ${(e as Error).message}`);
  }
}

export const COUNTRY_REMINDER_DELAY = "24h";

export async function sendCountryNeededIfMissing(
  memberId: string,
  read: (id: string) => Promise<{ country_code: string | null; vetting_state: string } | null> = readCountryState,
): Promise<"sent" | "not_needed"> {
  const m = await read(memberId);
  if (!m || m.vetting_state !== "approved" || (m.country_code ?? "").trim().length > 0) return "not_needed";
  await notify({
    recipient: { kind: "creator", human_member_id: memberId },
    event: "country_needed",
    scope_id: memberId,
  });
  return "sent";
}

async function readCountryState(
  memberId: string,
): Promise<{ country_code: string | null; vetting_state: string } | null> {
  const { data, error } = await sb()
    .from(MEMBERS)
    .select("country_code, vetting_state")
    .eq("id", memberId)
    .maybeSingle();
  if (error) fail(error);
  return (data as { country_code: string | null; vetting_state: string } | null) ?? null;
}

export async function refreshSetup(
  memberId: string,
  store: Pick<SetupStore, "facts" | "setApproved"> = setupStore,
  onLive: (memberId: string, countryMissing: boolean, earnMode: EarnMode | null) => Promise<void> = sendCreatorLive,
): Promise<SetupStatus> {
  const facts = await store.facts(memberId);
  const status = setupStatus(facts);
  if (autoApproveTarget(facts.vetting_state, status)) {
    if ((await store.setApproved(memberId)) === true) void onLive(memberId, !facts.country_code, status.earn_mode);
  }
  return status;
}

export { HumanError };
