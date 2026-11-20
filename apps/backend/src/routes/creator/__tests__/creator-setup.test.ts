
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { verifyBearerMock, resolveMock } = vi.hoisted(() => ({
  verifyBearerMock: vi.fn(),
  resolveMock: vi.fn(),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: verifyBearerMock }));
vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({}), selfAccountClient: () => ({}) }));
vi.mock("@/services/humans/store", () => ({ writeWithFreshSlug: vi.fn(), swapMemberHandles: vi.fn() }));
vi.mock("@/services/creators/notify", () => ({ notify: vi.fn() }));
vi.mock("@/services/creators/creator-invites", () => ({ linkInviteOnSignup: vi.fn(async () => 0) }));
vi.mock("@/services/creators/creator-area", () => ({
  CreatorAreaError: class extends Error {},
  resolveCreatorByAuthUser: resolveMock,
}));

import { makeCreatorSetupHandlers } from "../setup";
import {
  autoApproveTarget,
  packageRequired,
  parseEarnMode,
  readEarnMode,
  refreshSetup,
  parseAccounts,
  parseProfilePatch,
  setupStatus,
  type SetupStore,
} from "@/services/creators/creator-setup";

const USER_A = "auth-a";
const MEMBER_A = "member-a";

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Record<string, unknown>;
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: unknown) => {
    r.body = b;
    return r;
  };
  return r as unknown as Response & { statusCode: number; body: any };
}
const req = (body: unknown = {}) => ({ body, headers: {}, params: {} }) as unknown as Request;

type Facts = { has_dob: boolean; account_count: number; niche_count: number; active_package_count: number; vetting_state: string; earn_mode?: string | null };
function fakeStore(facts: Facts = { has_dob: false, account_count: 0, niche_count: 0, active_package_count: 0, vetting_state: "pending" }) {
  return {
    accountFacts: vi.fn(async () => ({ active_tenant: false, member_of_tenant: false, is_creator: false })),
    createAccount: vi.fn(async () => ({ id: MEMBER_A, created: true })),
    facts: vi.fn(async () => facts),
    saveDob: vi.fn(async () => {}),
    saveAge: vi.fn(async () => {}),
    saveAccounts: vi.fn(async () => {}),
    saveNiches: vi.fn(async () => {}),
    saveEarnMode: vi.fn(async () => {}),
    addPackage: vi.fn(async () => {}),
    updateProfile: vi.fn(async () => {}),
    setApproved: vi.fn(async () => {}),
    profile: vi.fn(async () => ({
      profile: { bio: "Hi", intro_video_path: `${USER_A}/abc.mp4`, country_code: null, skills: ["Tech"], vetting_state: "pending" },
      accounts: [{ platform: "tiktok", handle: "maya", followers: 1200 }],
    })),
  };
}

beforeEach(() => {
  verifyBearerMock.mockReset();
  resolveMock.mockReset();
  verifyBearerMock.mockResolvedValue({ user_id: USER_A, email: "a@example.com" });
  resolveMock.mockResolvedValue({ id: MEMBER_A, auth_user_id: USER_A, vetting_state: "pending", display_name: "A" });
});

describe("POST /api/creator/signup", () => {
  it("creates the creator from the token email, with no slug or proof asked for", async () => {
    const store = fakeStore();
    const h = makeCreatorSetupHandlers({ store: store as unknown as SetupStore });
    const r = res();
    await h.signup(req({ display_name: " Maya Films ", email: "evil@example.com", slug: "x", screenshots: ["p"] }), r);
    expect(r.statusCode).toBe(201);
    expect(store.createAccount).toHaveBeenCalledWith(USER_A, "Maya Films", "a@example.com");
  });

  it("links an outreach invite by the VERIFIED email and the new member id, not a body field", async () => {
    const store = fakeStore();
    const linkInvite = vi.fn(async () => 1);
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore, linkInvite }).signup(
      req({ display_name: "Maya", email: "evil@example.com" }),
      r,
    );
    expect(r.statusCode).toBe(201);
    expect(linkInvite).toHaveBeenCalledWith("a@example.com", MEMBER_A);
  });

  it("a failing invite link never fails the signup", async () => {
    const store = fakeStore();
    const linkInvite = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore, linkInvite }).signup(req({ display_name: "Maya" }), r);
    expect(r.statusCode).toBe(201);
    expect(r.body).toEqual({ ok: true, created: true });
    warn.mockRestore();
  });

  it("fills a NEW creator's accounts from the invite, after the link; never for an existing one", async () => {
    const order: string[] = [];
    const linkInvite = vi.fn(async () => (order.push("link"), 1));
    const prefillAccounts = vi.fn(async () => (order.push("prefill"), 2));
    const store = fakeStore();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore, linkInvite, prefillAccounts }).signup(req({ display_name: "Maya" }), res());
    expect(prefillAccounts).toHaveBeenCalledWith(MEMBER_A);
    expect(order).toEqual(["link", "prefill"]);

    prefillAccounts.mockClear();
    const existing = fakeStore();
    existing.createAccount.mockResolvedValue({ id: MEMBER_A, created: false });
    const r = res();
    await makeCreatorSetupHandlers({ store: existing as unknown as SetupStore, linkInvite, prefillAccounts }).signup(req({ display_name: "Maya" }), r);
    expect(r.statusCode).toBe(200);
    expect(prefillAccounts).not.toHaveBeenCalled();
  });

  it("a NEW creator starts with age 18 saved; an existing creator's age is never touched", async () => {
    const store = fakeStore();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).signup(req({ display_name: "Maya", age: 40 }), res());
    expect(store.saveAge).toHaveBeenCalledWith(MEMBER_A, 18, "a@example.com");

    const existing = fakeStore();
    existing.createAccount.mockResolvedValue({ id: MEMBER_A, created: false });
    await makeCreatorSetupHandlers({ store: existing as unknown as SetupStore }).signup(req({ display_name: "Maya" }), res());
    expect(existing.saveAge).not.toHaveBeenCalled();
  });

  it("a failing default age never fails the signup", async () => {
    const store = fakeStore();
    store.saveAge.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).signup(req({ display_name: "Maya" }), r);
    expect(r.statusCode).toBe(201);
    warn.mockRestore();
  });

  it("a failing accounts prefill never fails the signup", async () => {
    const prefillAccounts = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = res();
    await makeCreatorSetupHandlers({ store: fakeStore() as unknown as SetupStore, prefillAccounts }).signup(req({ display_name: "Maya" }), r);
    expect(r.statusCode).toBe(201);
    expect(r.body).toEqual({ ok: true, created: true });
    warn.mockRestore();
  });

  it("401s without a bearer", async () => {
    verifyBearerMock.mockResolvedValue(null);
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).signup(req({ display_name: "x" }), r);
    expect(r.statusCode).toBe(401);
    expect(store.createAccount).not.toHaveBeenCalled();
  });
});

describe("a company account never becomes a creator, and home is decided on the server", () => {
  it("signup refuses an account that already has a company, and writes nothing", async () => {
    for (const facts of [
      { active_tenant: true, member_of_tenant: true, is_creator: false },
      { active_tenant: false, member_of_tenant: true, is_creator: false },
    ]) {
      const store = fakeStore();
      store.accountFacts.mockResolvedValue(facts);
      const linkInvite = vi.fn(async () => 1);
      const r = res();
      await makeCreatorSetupHandlers({ store: store as unknown as SetupStore, linkInvite }).signup(req({ display_name: "Maya" }), r);
      expect(r.statusCode).toBe(409);
      expect(r.body.error.code).toBe("has_company");
      expect(store.createAccount).not.toHaveBeenCalled();
      expect(linkInvite).not.toHaveBeenCalled();
    }
  });

  it("GET /api/creator/home: company -> /workspace; existing creator-only accounts retain settlement access", async () => {
    const cases: Array<[{ active_tenant: boolean; member_of_tenant: boolean; is_creator: boolean }, string]> = [
      [{ active_tenant: true, member_of_tenant: true, is_creator: true }, "/workspace"],
      [{ active_tenant: true, member_of_tenant: true, is_creator: false }, "/workspace"],
      [{ active_tenant: false, member_of_tenant: true, is_creator: true }, "/start"],
      [{ active_tenant: false, member_of_tenant: false, is_creator: true }, "/creator"],
      [{ active_tenant: false, member_of_tenant: false, is_creator: false }, "/start"],
    ];
    for (const [facts, home] of cases) {
      const store = fakeStore();
      store.accountFacts.mockResolvedValue(facts);
      const r = res();
      await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).home(req(), r);
      expect(r.body.home, JSON.stringify(facts)).toBe(home);
      expect(store.accountFacts).toHaveBeenCalledWith(USER_A);
    }
  });

  it("a failed read is an error, never a guessed home", async () => {
    const store = fakeStore();
    store.accountFacts.mockRejectedValue(new Error("db down"));
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).home(req(), r);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.body.home).toBeUndefined();
  });
});

describe("setup steps", () => {
  it("refuses under 18 and writes nothing", async () => {
    const store = fakeStore();
    const r = res();
    const y = new Date().getUTCFullYear() - 16;
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(req({ date_of_birth: `${y}-01-01` }), r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("under_18");
    expect(store.saveDob).not.toHaveBeenCalled();
  });

  it("saves the date for the caller's own member and never echoes it", async () => {
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(
      req({ date_of_birth: "1998-04-12", member_id: "member-b" }),
      r,
    );
    expect(store.saveDob).toHaveBeenCalledWith(MEMBER_A, "1998-04-12", "a@example.com");
    expect(JSON.stringify(r.body)).not.toContain("1998");
  });

  it("saves a picked age for the caller, and never writes a date", async () => {
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(req({ age: 22, member_id: "member-b" }), r);
    expect(store.saveAge).toHaveBeenCalledWith(MEMBER_A, 22, "a@example.com");
    expect(store.saveDob).not.toHaveBeenCalled();
  });

  it("refuses an age under 18 or not a whole number, and writes nothing", async () => {
    for (const [age, code] of [[16, "under_18"], ["abc", "validation"], [22.5, "validation"]] as const) {
      const store = fakeStore();
      const r = res();
      await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(req({ age }), r);
      expect(r.statusCode).toBe(400);
      expect(r.body.error.code).toBe(code);
      expect(store.saveAge).not.toHaveBeenCalled();
    }
  });

  it("make step writes accounts and niches to the caller only", async () => {
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).make(
      req({ accounts: [{ platform: "tiktok", handle: "tiktok.com/@maya", followers: "48,000" }], niches: ["Tech"] }),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(store.saveAccounts).toHaveBeenCalledWith(MEMBER_A, [{ platform: "tiktok", handle: "maya", followers: 48000 }]);
    expect(store.saveNiches).toHaveBeenCalledWith(MEMBER_A, ["Tech"]);
  });

  it("auto-approves a pending creator once all three steps are done", async () => {
    const store = fakeStore({ has_dob: true, account_count: 1, niche_count: 1, active_package_count: 1, vetting_state: "pending" });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).addPackage(
      req({
        package: { kind: "ugc_video", title: "1 UGC video, 30s", price_cents: 15000, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 90 },
      }),
      r,
    );
    expect(r.statusCode).toBe(201);
    expect(store.setApproved).toHaveBeenCalledWith(MEMBER_A);
  });

  it("sends the You're live email only from the call that approved", async () => {
    const done = { has_dob: true, account_count: 1, niche_count: 1, active_package_count: 1 };
    const onLive = vi.fn(async () => {});
    const moved = { facts: vi.fn(async () => ({ ...done, vetting_state: "pending", country_code: null })), setApproved: vi.fn(async () => true) };
    await refreshSetup(MEMBER_A, moved as unknown as SetupStore, onLive);
    expect(onLive).toHaveBeenCalledWith(MEMBER_A, true, null);

    onLive.mockClear();
    const lost = { facts: vi.fn(async () => ({ ...done, vetting_state: "pending", country_code: "US" })), setApproved: vi.fn(async () => false) };
    await refreshSetup(MEMBER_A, lost as unknown as SetupStore, onLive);
    expect(onLive).not.toHaveBeenCalled();

    const approved = { facts: vi.fn(async () => ({ ...done, vetting_state: "approved", country_code: "US" })), setApproved: vi.fn(async () => true) };
    await refreshSetup(MEMBER_A, approved as unknown as SetupStore, onLive);
    expect(approved.setApproved).not.toHaveBeenCalled();
    expect(onLive).not.toHaveBeenCalled();
  });

  it("does not approve when a step is missing", async () => {
    const store = fakeStore({ has_dob: true, account_count: 0, niche_count: 1, active_package_count: 1, vetting_state: "pending" });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(req({ date_of_birth: "1990-01-01" }), r);
    expect(store.setApproved).not.toHaveBeenCalled();
    expect(r.body.setup.done).toBe(2);
  });
});

describe("how you want to earn (affiliate-only approval, 2026-10-18)", () => {
  const AGE_AND_MAKE = { has_dob: true, account_count: 1, niche_count: 1, active_package_count: 0, vetting_state: "pending" };

  it("saves the pick for the caller's own member, and needs at least one", async () => {
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).earn(req({ affiliate: true, jobs: true, member_id: "member-b" }), r);
    expect(r.statusCode).toBe(200);
    expect(store.saveEarnMode).toHaveBeenCalledWith(MEMBER_A, "both");

    const none = fakeStore();
    const r2 = res();
    await makeCreatorSetupHandlers({ store: none as unknown as SetupStore }).earn(req({ affiliate: false, jobs: false }), r2);
    expect(r2.statusCode).toBe(400);
    expect(r2.body.error.message).toBe("Pick at least one.");
    expect(none.saveEarnMode).not.toHaveBeenCalled();
    expect(none.setApproved).not.toHaveBeenCalled();
  });

  it("affiliate only is approved with age and What you make, and no package", async () => {
    const store = fakeStore({ ...AGE_AND_MAKE, earn_mode: "affiliate" });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).make(
      req({ accounts: [{ platform: "tiktok", handle: "@maya", followers: "1,200" }], niches: ["Tech"] }),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(store.setApproved).toHaveBeenCalledWith(MEMBER_A);
    expect(r.body.setup).toMatchObject({ complete: true, package_required: false, done: 3, total: 3, earn_mode: "affiliate" });
  });

  it("jobs only is NOT approved without a package", async () => {
    const store = fakeStore({ ...AGE_AND_MAKE, earn_mode: "jobs" });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).earn(req({ jobs: true }), r);
    expect(store.setApproved).not.toHaveBeenCalled();
    expect(r.body.setup).toMatchObject({ complete: false, package_required: true, done: 3, total: 4 });
  });

  it("both needs a package, and is approved once it has one", async () => {
    const without = fakeStore({ ...AGE_AND_MAKE, earn_mode: "both" });
    const r = res();
    await makeCreatorSetupHandlers({ store: without as unknown as SetupStore }).earn(req({ affiliate: true, jobs: true }), r);
    expect(without.setApproved).not.toHaveBeenCalled();
    expect(r.body.setup.complete).toBe(false);

    const withPkg = fakeStore({ ...AGE_AND_MAKE, active_package_count: 1, earn_mode: "both" });
    await makeCreatorSetupHandlers({ store: withPkg as unknown as SetupStore }).earn(req({ affiliate: true, jobs: true }), res());
    expect(withPkg.setApproved).toHaveBeenCalledWith(MEMBER_A);
  });

  it("under 18 is never approved, affiliate only included", async () => {
    const store = fakeStore({ ...AGE_AND_MAKE, has_dob: false, earn_mode: "affiliate" });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).dob(req({ age: 17 }), r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("under_18");
    expect(store.saveAge).not.toHaveBeenCalled();
    expect(store.setApproved).not.toHaveBeenCalled();

    for (const mode of ["affiliate", "jobs", "both", null]) {
      const s2 = fakeStore({ ...AGE_AND_MAKE, has_dob: false, active_package_count: 1, earn_mode: mode });
      const r2 = res();
      await makeCreatorSetupHandlers({ store: s2 as unknown as SetupStore }).make(
        req({ accounts: [{ platform: "tiktok", handle: "@maya", followers: "1,200" }], niches: ["Tech"] }),
        r2,
      );
      expect(s2.setApproved, String(mode)).not.toHaveBeenCalled();
      expect(r2.body.setup.complete, String(mode)).toBe(false);
    }
  });

  it("fails closed: no pick, or a value the code does not know, still needs a package", async () => {
    for (const mode of [null, undefined, "", "Affiliate", "affiliate ", "everything"]) {
      expect(packageRequired(readEarnMode(mode)), String(mode)).toBe(true);
      const store = fakeStore({ ...AGE_AND_MAKE, earn_mode: mode as string | null });
      await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).make(
        req({ accounts: [{ platform: "tiktok", handle: "@maya", followers: "1,200" }], niches: ["Tech"] }),
        res(),
      );
      expect(store.setApproved, String(mode)).not.toHaveBeenCalled();
    }
    expect(() => parseEarnMode({ affiliate: "yes" })).toThrow("Pick at least one.");
  });

  it("a rejected affiliate-only creator stays rejected", () => {
    const status = setupStatus({ has_dob: true, account_count: 1, niche_count: 1, active_package_count: 0, earn_mode: "affiliate" });
    expect(status.complete).toBe(true);
    expect(autoApproveTarget("rejected", status)).toBeNull();
  });

  it("the live email is told the creator picked affiliate only", async () => {
    const onLive = vi.fn(async () => {});
    const store = { facts: vi.fn(async () => ({ ...AGE_AND_MAKE, earn_mode: "affiliate", country_code: null })), setApproved: vi.fn(async () => true) };
    await refreshSetup(MEMBER_A, store as unknown as SetupStore, onLive);
    expect(onLive).toHaveBeenCalledWith(MEMBER_A, true, "affiliate");
  });
});

describe("gate", () => {
  it("a founder with no creator row gets 403 not_a_creator", async () => {
    resolveMock.mockResolvedValue(null);
    const store = fakeStore();
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).profile(req(), r);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("not_a_creator");
  });

  it("a rejected creator is kept out", async () => {
    resolveMock.mockResolvedValue({ id: MEMBER_A, auth_user_id: USER_A, vetting_state: "rejected" });
    const r = res();
    await makeCreatorSetupHandlers({ store: fakeStore() as unknown as SetupStore }).profile(req(), r);
    expect(r.statusCode).toBe(403);
  });

  it("profile labels the intro video, never its storage path or UUID, and labels followers", async () => {
    const r = res();
    await makeCreatorSetupHandlers({ store: fakeStore() as unknown as SetupStore }).profile(req(), r);
    expect(r.body.intro_video_name).toBe("Intro video");
    expect(JSON.stringify(r.body)).not.toContain("abc.mp4");
    expect(r.body.accounts[0]).toMatchObject({ followers: 1200, label: "Self-reported, not checked by Zavi", url: "https://www.tiktok.com/@maya" });
  });
});

describe("pure rules", () => {
  it("setupStatus counts steps", () => {
    expect(setupStatus({ has_dob: true, account_count: 1, niche_count: 0, active_package_count: 1 })).toMatchObject({ done: 2, make: false, complete: false });
  });
  it("only pending creators are auto-approved", () => {
    const all = setupStatus({ has_dob: true, account_count: 1, niche_count: 1, active_package_count: 1 });
    expect(autoApproveTarget("pending", all)).toBe("approved");
    expect(autoApproveTarget("rejected", all)).toBeNull();
    expect(autoApproveTarget("approved", all)).toBeNull();
  });
  it("rejects a javascript: link and a duplicate platform", () => {
    expect(() => parseAccounts([{ platform: "tiktok", handle: "javascript:alert(1)", followers: 1 }])).toThrow();
    expect(() => parseAccounts([{ platform: "x", handle: "a", followers: 1 }, { platform: "x", handle: "b", followers: 1 }])).toThrow();
  });
  it("an intro video path must be under the caller's own prefix", () => {
    expect(() => parseProfilePatch({ intro_video_path: "someone-else/v.mp4" }, USER_A)).toThrow();
    expect(parseProfilePatch({ intro_video_path: `${USER_A}/v.mp4` }, USER_A)).toEqual({ intro_video_path: `${USER_A}/v.mp4` });
  });
});

describe("profile photo (2026-09-28)", () => {
  const patchReq = (body: unknown) => req(body);
  const SAVED = "media/0b8f5c1e-1111-4111-8111-111111111111.jpg";
  const withPhoto = (adopt: unknown) => ({
    ...fakeStore(),
    adoptPhoto: vi.fn(async () => adopt),
    discardUpload: vi.fn(async () => undefined),
    signMedia: vi.fn(),
  });

  it("parseProfilePatch: the name is trimmed, required when sent, and capped", () => {
    expect(parseProfilePatch({ display_name: "  Tarun A  " }, USER_A)).toEqual({ display_name: "Tarun A" });
    expect(() => parseProfilePatch({ display_name: "   " }, USER_A)).toThrow(/Add your name/);
    expect(() => parseProfilePatch({ display_name: "x".repeat(121) }, USER_A)).toThrow(/under 120/);
    expect(parseProfilePatch({ bio: "hi" }, USER_A)).not.toHaveProperty("display_name");
  });

  it("parseProfilePatch: a photo path must be the caller's own upload, an image key, and null removes it", () => {
    expect(() => parseProfilePatch({ photo_path: "auth-b/p.jpg" }, USER_A)).toThrow(/not one you uploaded/);
    expect(() => parseProfilePatch({ photo_path: `${USER_A}/../auth-b/p.jpg` }, USER_A)).toThrow();
    expect(() => parseProfilePatch({ photo_path: SAVED }, USER_A)).toThrow(/not one you uploaded/);
    expect(() => parseProfilePatch({ photo_path: `${USER_A}/v.mp4` }, USER_A)).toThrow(/JPG, PNG or WebP/);
    expect(parseProfilePatch({ photo_path: `${USER_A}/p.webp` }, USER_A)).toEqual({ photo_path: `${USER_A}/p.webp` });
    expect(parseProfilePatch({ photo_path: null }, USER_A)).toEqual({ photo_path: null });
  });

  it.each([["auth-b/stolen.jpg"], [SAVED]])("PATCH refuses %s with 403 and writes nothing", async (path) => {
    const store = withPhoto({ ok: true, path: SAVED });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(patchReq({ photo_path: path }), r);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("media_not_owned");
    expect(store.adoptPhoto).not.toHaveBeenCalled();
    expect(store.updateProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["too_large", 413, "file_too_large"],
    ["not_image", 400, "unsupported_media_type"],
    ["missing", 400, "upload_missing"],
  ] as const)("PATCH refuses a stored object that is %s", async (reason, status, code) => {
    const store = withPhoto({ ok: false, reason });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(patchReq({ photo_path: `${USER_A}/p.jpg` }), r);
    expect(r.statusCode).toBe(status);
    expect(r.body.error.code).toBe(code);
    expect(store.updateProfile).not.toHaveBeenCalled();
  });

  it("PATCH saves the server's identifier-free copy, not the upload key, on the member minted from the verified sub", async () => {
    const store = withPhoto({ ok: true, path: SAVED });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(
      patchReq({ photo_path: `${USER_A}/p.jpg`, human_member_id: "member-b" }),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(store.adoptPhoto).toHaveBeenCalledWith(USER_A, `${USER_A}/p.jpg`);
    expect(store.updateProfile).toHaveBeenCalledWith(MEMBER_A, { photo_path: SAVED });
    expect(JSON.stringify(store.updateProfile.mock.calls)).not.toContain(USER_A);
  });

  it("PATCH drops the staged upload only AFTER the new key is saved, so a failed save can be retried", async () => {
    const ok = withPhoto({ ok: true, path: SAVED });
    await makeCreatorSetupHandlers({ store: ok as unknown as SetupStore }).patchProfile(patchReq({ photo_path: `${USER_A}/p.jpg` }), res());
    expect(ok.discardUpload).toHaveBeenCalledWith(USER_A, `${USER_A}/p.jpg`);
    expect(ok.updateProfile.mock.invocationCallOrder[0]).toBeLessThan(ok.discardUpload.mock.invocationCallOrder[0]);

    const failing = withPhoto({ ok: true, path: SAVED });
    failing.updateProfile.mockRejectedValueOnce(new Error("db down"));
    await makeCreatorSetupHandlers({ store: failing as unknown as SetupStore }).patchProfile(patchReq({ photo_path: `${USER_A}/p.jpg` }), res());
    expect(failing.discardUpload).not.toHaveBeenCalled();
  });

  it("PATCH photo_path: null removes the photo without touching storage", async () => {
    const store = withPhoto({ ok: true, path: SAVED });
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(patchReq({ photo_path: null }), r);
    expect(r.statusCode).toBe(200);
    expect(store.adoptPhoto).not.toHaveBeenCalled();
    expect(store.updateProfile).toHaveBeenCalledWith(MEMBER_A, { photo_path: null });
  });

  it("GET profile returns signed URLs for the creator's own images, never the paths", async () => {
    const store = {
      ...fakeStore(),
      profile: vi.fn(async () => ({
        profile: {
          bio: null,
          intro_video_path: null,
          photo_path: SAVED,
          illustration_path: "media/2b8f5c1e-1111-4111-8111-111111111111.png",
          country_code: null,
          skills: [],
          vetting_state: "approved",
        },
        accounts: [],
      })),
      signMedia: vi.fn(async (p: string) => `https://signed.test/${p.endsWith(".jpg") ? "photo" : "ill"}?token=t`),
    };
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).profile(req(), r);
    expect(r.body.photo_url).toBe("https://signed.test/photo?token=t");
    expect(r.body.illustration_url).toBe("https://signed.test/ill?token=t");
    expect(store.signMedia).toHaveBeenCalledWith(SAVED, USER_A);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(USER_A);
    expect(json).not.toMatch(/photo_path|illustration_path|media\//);
  });
});

describe("payout country is locked once a Stripe account exists", () => {
  it("allows only a payout country update after the creator marketplace is retired", async () => {
    const store = { ...fakeStore(), payoutAccountCountry: vi.fn(async () => null) };
    const handlers = makeCreatorSetupHandlers({ store: store as unknown as SetupStore, marketplaceEnabled: false });

    const country = res();
    await handlers.patchProfile(req({ country_code: "GB" }), country);
    expect(country.statusCode).toBe(200);
    expect(store.updateProfile).toHaveBeenCalledWith(MEMBER_A, { country_code: "GB" });

    store.updateProfile.mockClear();
    const profile = res();
    await handlers.patchProfile(req({ country_code: "GB", bio: "new supply" }), profile);
    expect(profile.statusCode).toBe(410);
    expect(profile.body.error.code).toBe("creator_marketplace_unavailable");
    expect(store.updateProfile).not.toHaveBeenCalled();
  });

  it("refuses a different country with 409 and writes nothing", async () => {
    const store = { ...fakeStore(), payoutAccountCountry: vi.fn(async () => "US") };
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(req({ country_code: "gb" }), r);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("country_locked");
    expect(store.updateProfile).not.toHaveBeenCalled();
  });

  it("allows re-saving the same country", async () => {
    const store = { ...fakeStore(), payoutAccountCountry: vi.fn(async () => "US") };
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(req({ country_code: "us" }), r);
    expect(r.statusCode).toBe(200);
    expect(store.updateProfile).toHaveBeenCalled();
  });

  it("allows any country before Stripe payouts are set up", async () => {
    const store = { ...fakeStore(), payoutAccountCountry: vi.fn(async () => null) };
    const r = res();
    await makeCreatorSetupHandlers({ store: store as unknown as SetupStore }).patchProfile(req({ country_code: "GB" }), r);
    expect(r.statusCode).toBe(200);
  });
});
