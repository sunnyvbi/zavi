
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import {
  CreatorSetupError,
  CREATOR_NICHES,
  decideHome,
  parseAccounts,
  parseDisplayName,
  parseAge,
  parseDob,
  parseEarnMode,
  parseNiches,
  parsePackage,
  parseProfilePatch,
  refreshSetup,
  setupStore,
  type SetupStore,
} from "@/services/creators/creator-setup";
import { HumanError } from "@/services/humans/contract";
import { linkInviteOnSignup } from "@/services/creators/creator-invites";
import { carryInviteMessages, prefillInviteAccounts } from "@/services/creators/invite-messages";
import { loadHumanMemberByAuthUser } from "@/services/humans/member";
import { CREATOR_MARKETPLACE_ENABLED, socialUrl } from "@zavi/shared";
import { requireCreator, sendCreatorError } from "./auth";
import { realIntroVideoDeps, streamIntroVideo, type IntroVideoDeps } from "@/services/creators/intro-video";

type Deps = {
  store: SetupStore;
  marketplaceEnabled?: boolean;
  linkInvite?: (email: string, memberId: string) => Promise<number>;
  carryMessages?: (memberId: string) => Promise<number>;
  prefillAccounts?: (memberId: string) => Promise<number>;
  memberIdOf?: (authUserId: string) => Promise<string | null>;
  video?: IntroVideoDeps;
};
const realDeps: Deps = {
  store: setupStore,
  marketplaceEnabled: CREATOR_MARKETPLACE_ENABLED,
  linkInvite: linkInviteOnSignup,
  carryMessages: carryInviteMessages,
  prefillAccounts: prefillInviteAccounts,
  memberIdOf: async (authUserId) => (await loadHumanMemberByAuthUser(authUserId))?.id ?? null,
};

function sendSetupError(res: Response, e: unknown): void {
  if (e instanceof CreatorSetupError || e instanceof HumanError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  sendCreatorError(res, e);
}

export function makeCreatorSetupHandlers(deps: Deps = realDeps) {
  const { store } = deps;
  const linkInvite = deps.linkInvite ?? linkInviteOnSignup;
  const carryMessages = deps.carryMessages ?? (async () => 0);
  const prefillAccounts = deps.prefillAccounts ?? (async () => 0);
  const memberIdOf = deps.memberIdOf ?? (async () => null);
  const marketplaceEnabled = deps.marketplaceEnabled ?? true;

  async function signup(req: Request, res: Response): Promise<void> {
    const verified = await verifyBearer(req);
    if (!verified) {
      res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
      return;
    }
    try {
      const name = parseDisplayName((req.body ?? {}).display_name);
      const facts = await store.accountFacts(verified.user_id);
      if (!facts.is_creator && (facts.active_tenant || facts.member_of_tenant)) {
        throw new CreatorSetupError(
          "has_company",
          "This email already has a Zavi company account. Sign up as a creator with a different email.",
          409,
        );
      }
      if (!verified.email) throw new CreatorSetupError("validation", "Your account has no email address.");
      const out = await store.createAccount(verified.user_id, name, verified.email);
      try {
        await linkInvite(verified.email, out.id);
      } catch (e) {
        console.warn(`[creator signup] invite link failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        if (out.created) await prefillAccounts(out.id);
      } catch (e) {
        console.warn(`[creator signup] invite accounts prefill failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        if (out.created) await store.saveAge(out.id, 18, verified.email);
      } catch (e) {
        console.warn(`[creator signup] default age failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await carryMessages(out.id);
      } catch (e) {
        console.warn(`[creator signup] invite messages carry failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      res.status(out.created ? 201 : 200).json({ ok: true, created: out.created });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function home(req: Request, res: Response): Promise<void> {
    const verified = await verifyBearer(req);
    if (!verified) {
      res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
      return;
    }
    try {
      res.json(decideHome(await store.accountFacts(verified.user_id)));
    } catch (e) {
      sendSetupError(res, e);
    }
    void memberIdOf(verified.user_id)
      .then((id) => (id ? carryMessages(id) : 0))
      .catch((e) => console.warn(`[creator home] invite messages carry failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  async function profile(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const { profile: p, accounts } = await store.profile(me.member_id);
      const [photo_url, illustration_url] = await Promise.all([
        p.photo_path ? store.signMedia(p.photo_path, me.auth_user_id) : Promise.resolve(null),
        p.illustration_path ? store.signMedia(p.illustration_path, me.auth_user_id) : Promise.resolve(null),
      ]);
      const age = typeof store.ownAge === "function" ? await store.ownAge(me.member_id) : null;
      res.json({
        age,
        bio: p.bio,
        intro_video_name: p.intro_video_path ? "Intro video" : null,
        photo_url,
        illustration_url,
        niches: p.skills ?? [],
        niche_options: CREATOR_NICHES,
        country_code: p.country_code,
        accounts: accounts.map((a) => ({
          platform: a.platform,
          handle: a.handle,
          url: socialUrl(a.platform, a.handle),
          followers: a.followers,
          label: "Self-reported, not checked by Zavi",
        })),
      });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function earn(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const mode = parseEarnMode(req.body);
      await store.saveEarnMode(me.member_id, mode);
      res.json({ ok: true, setup: await refreshSetup(me.member_id, store) });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function dob(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.age !== undefined) {
        await store.saveAge(me.member_id, parseAge(body.age), me.email);
      } else {
        await store.saveDob(me.member_id, parseDob(body.date_of_birth), me.email);
      }
      res.json({ ok: true, setup: await refreshSetup(me.member_id, store) });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function make(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const accounts = parseAccounts(body.accounts);
      const niches = body.niches === undefined ? null : parseNiches(body.niches);
      if (niches && accounts.length === 0) {
        throw new CreatorSetupError("validation", "Pick at least one platform.");
      }
      await store.saveAccounts(me.member_id, accounts);
      if (niches) await store.saveNiches(me.member_id, niches);
      res.json({ ok: true, setup: await refreshSetup(me.member_id, store) });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function addPackage(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const pkg = parsePackage((req.body ?? {}).package);
      await store.addPackage(me.member_id, pkg);
      res.status(201).json({ ok: true, setup: await refreshSetup(me.member_id, store) });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function patchProfile(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!marketplaceEnabled && (Object.keys(body).length !== 1 || body.country_code === undefined)) {
        throw new CreatorSetupError(
          "creator_marketplace_unavailable",
          "Creator profile changes are unavailable. You can still add a payout country for existing work.",
          410,
        );
      }
      const patch = parseProfilePatch(req.body, me.auth_user_id);
      if (patch.country_code && typeof store.payoutAccountCountry === "function") {
        const locked = await store.payoutAccountCountry(me.member_id);
        if (locked && locked !== patch.country_code) {
          throw new CreatorSetupError(
            "country_locked",
            "Your payout country is set by your Stripe account and cannot change here. Contact Zavi support to move it.",
            409,
          );
        }
      }
      let staged: string | null = null;
      if (patch.photo_path) {
        const adopted = await store.adoptPhoto(me.auth_user_id, patch.photo_path);
        if (!adopted.ok) {
          if (adopted.reason === "missing") throw new CreatorSetupError("upload_missing", "That photo did not finish uploading. Try again.");
          if (adopted.reason === "too_large") throw new CreatorSetupError("file_too_large", "Photos can be up to 5 MB.", 413);
          throw new CreatorSetupError("unsupported_media_type", "Upload a JPG, PNG or WebP photo.");
        }
        staged = patch.photo_path;
        patch.photo_path = adopted.path;
      }
      await store.updateProfile(me.member_id, patch);
      if (staged) await store.discardUpload(me.auth_user_id, staged).catch(() => undefined);
      res.json({ ok: true });
    } catch (e) {
      sendSetupError(res, e);
    }
  }

  async function introVideo(req: Request, res: Response): Promise<void> {
    const me = await requireCreator(req, res);
    if (!me) return;
    let path: string | null;
    try {
      path = (await store.profile(me.member_id)).profile.intro_video_path;
    } catch (e) {
      sendSetupError(res, e);
      return;
    }
    await streamIntroVideo(res, path, me.auth_user_id, deps.video ?? realIntroVideoDeps);
  }

  return { signup, home, profile, earn, dob, make, addPackage, patchProfile, introVideo };
}

const h = makeCreatorSetupHandlers();
export const postCreatorSignup = h.signup;
export const getCreatorHome = h.home;
export const getCreatorProfile = h.profile;
export const postCreatorSetupEarn = h.earn;
export const postCreatorSetupDob = h.dob;
export const postCreatorSetupMake = h.make;
export const postCreatorPackage = h.addPackage;
export const patchCreatorProfile = h.patchProfile;
export const getMyIntroVideo = h.introVideo;
