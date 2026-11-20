import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  anchorBackend,
  _setAnchorClient,
  _resetAnchorSessionCache,
  _setBrowserSessionTracker,
  _setBrowserActionEmitter,
  type AnchorClient,
  type AnchorSession,
} from "../anchor-backend";
import type { BrowserToolCtx, DaemonOp } from "../types";

vi.mock("@/agents/social/social-publish-flag", () => ({
  isSocialPublishEnabled: vi.fn(async () => false),
  SOCIAL_PUBLISH_FLAG_KEY: "social_publish_paused",
  SOCIAL_PUBLISH_PAUSE_KEY: "social_publish_paused",
}));
vi.mock("../social-connections", () => ({
  getConnectedSocialAccount: vi.fn(async () => null),
  getSocialCredentials: vi.fn(async () => ({ username: "u@x.com", password: "pw" })),
  setSocialConnection: vi.fn(async () => {}),
  markSocialAccountChallenged: vi.fn(async () => {}),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";
import {
  getConnectedSocialAccount,
  getSocialCredentials,
  setSocialConnection,
  markSocialAccountChallenged,
} from "../social-connections";

const mFlag = vi.mocked(isSocialPublishEnabled);
const mAccount = vi.mocked(getConnectedSocialAccount);
const mCreds = vi.mocked(getSocialCredentials);
const mSet = vi.mocked(setSocialConnection);
const mChallenged = vi.mocked(markSocialAccountChallenged);

const LI_NAV: DaemonOp = { op: "nav", url: "https://www.linkedin.com/feed/" };

function ctxFor(slug: string, user_id: string | undefined = "user-A"): BrowserToolCtx {
  return { tenant_id: "t1", run_id: `run-${slug}-${Math.random()}`, agent_slug: slug, repo_full_name: "x/y", user_id };
}

function mockClient(opts?: { landingUrl?: string }): AnchorClient & {
  createCalls: Array<{ profileId?: string }>;
  ops: DaemonOp[];
} {
  const createCalls: Array<{ profileId?: string }> = [];
  const ops: DaemonOp[] = [];
  const session: AnchorSession = { id: "anchor-sess-123", cdp_url: "wss://x" };
  return {
    createCalls,
    ops,
    createSession: vi.fn(async (o: { apiKey: string; profileId?: string }) => {
      createCalls.push({ profileId: o.profileId });
      return session;
    }),
    runAction: vi.fn(async (a: { op: DaemonOp }) => {
      ops.push(a.op);
      if (a.op.op === "current_url") {
        return { ok: true as const, result: opts?.landingUrl ?? "https://www.linkedin.com/feed/" };
      }
      return { ok: true as const };
    }),
    closeSession: vi.fn(async () => {}),
  };
}

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  process.env.ANCHOR_API_KEY = "test-key";
  _resetAnchorSessionCache();
  _setBrowserSessionTracker({ open: vi.fn(async () => "db-sess"), close: vi.fn(async () => {}) });
  _setBrowserActionEmitter({ emit: vi.fn(async () => "d") });
  mFlag.mockResolvedValue(false);
  mAccount.mockResolvedValue(null);
  mCreds.mockResolvedValue({ username: "u@x.com", password: "pw" });
  mSet.mockClear();
  mChallenged.mockClear();
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = prevKey;
  _setAnchorClient(null);
  _setBrowserSessionTracker(null);
  _setBrowserActionEmitter(null);
  _resetAnchorSessionCache();
  vi.clearAllMocks();
});

describe("Anchor login-wiring — flag gate (fail-safe)", () => {
  it("flag OFF → NO cred injection, plain session, behaves as today", async () => {
    mFlag.mockResolvedValue(false);
    mAccount.mockResolvedValue({ platform: "linkedin", handle: "h", anchor_profile_id: "p1" });
    const client = mockClient();
    _setAnchorClient(client);

    const r = await anchorBackend.runOp(ctxFor("browser-operator"), LI_NAV);
    expect(r.ok).toBe(true);
    expect(client.createCalls).toEqual([{ profileId: undefined }]);
    expect(mCreds).not.toHaveBeenCalled();
    expect(mSet).not.toHaveBeenCalled();
  });
});

describe("Anchor login-wiring — retired (no slug logs in)", () => {
  it("browser-operator with flag ON + a connected profile → plain session, no login", async () => {
    mFlag.mockResolvedValue(true);
    mAccount.mockResolvedValue({ platform: "linkedin", handle: "h", anchor_profile_id: "profile-abc" });
    const client = mockClient();
    _setAnchorClient(client);

    const r = await anchorBackend.runOp(ctxFor("browser-operator"), LI_NAV);
    expect(r.ok).toBe(true);
    expect(client.createCalls).toEqual([{ profileId: undefined }]);
    expect(client.ops.filter((o) => o.op === "fill")).toHaveLength(0);
    expect(mCreds).not.toHaveBeenCalled();
    expect(mSet).not.toHaveBeenCalled();
  });

  it("a logged_out ctx (browser__task) never resolves an account or a profile", async () => {
    mFlag.mockResolvedValue(true);
    mAccount.mockResolvedValue({ platform: "linkedin", handle: "h", anchor_profile_id: "profile-abc" });
    const client = mockClient();
    _setAnchorClient(client);

    const r = await anchorBackend.runOp({ ...ctxFor("browser-task"), logged_out: true }, LI_NAV);
    expect(r.ok).toBe(true);
    expect(client.createCalls).toEqual([{ profileId: undefined }]);
    expect(mAccount).not.toHaveBeenCalled();
    expect(mCreds).not.toHaveBeenCalled();
  });

  it("Gap3/D1 fail-closed — a run with NO initiating user (cron/system) drives NO login + no persist", async () => {
    mFlag.mockResolvedValue(true);
    mAccount.mockResolvedValue({ platform: "linkedin", handle: "h", anchor_profile_id: null });
    const client = mockClient();
    _setAnchorClient(client);
    const noUserCtx: BrowserToolCtx = {
      tenant_id: "t1",
      run_id: "run-nouser",
      agent_slug: "browser-operator",
      repo_full_name: "x/y",
    };
    const r = await anchorBackend.runOp(noUserCtx, LI_NAV);
    expect(r.ok).toBe(true);
    expect(client.ops.filter((o) => o.op === "fill")).toHaveLength(0);
    expect(mCreds).not.toHaveBeenCalled();
    expect(mSet).not.toHaveBeenCalled();
  });
});

describe("Anchor login-wiring — least privilege", () => {
  it("NON-browser-operator slug → NO cred injection even with flag ON + connected account", async () => {
    mFlag.mockResolvedValue(true);
    mAccount.mockResolvedValue({ platform: "linkedin", handle: "h", anchor_profile_id: null });
    const client = mockClient();
    _setAnchorClient(client);

    const r = await anchorBackend.runOp(ctxFor("qa"), LI_NAV);
    expect(r.ok).toBe(true);
    expect(client.createCalls).toEqual([{ profileId: undefined }]);
    expect(mAccount).not.toHaveBeenCalled();
    expect(mCreds).not.toHaveBeenCalled();
    expect(mSet).not.toHaveBeenCalled();
  });

  it("flag ON, auto-execute slug, but NO connected account / non-social origin → no injection", async () => {
    mFlag.mockResolvedValue(true);
    mAccount.mockResolvedValue(null);
    const client = mockClient();
    _setAnchorClient(client);

    const r = await anchorBackend.runOp(ctxFor("browser-operator"), {
      op: "nav",
      url: "https://example.com/",
    });
    expect(r.ok).toBe(true);
    expect(client.createCalls).toEqual([{ profileId: undefined }]);
    expect(mCreds).not.toHaveBeenCalled();
    expect(mSet).not.toHaveBeenCalled();
  });
});
