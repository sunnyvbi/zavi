
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  listConnectedAccounts: vi.fn(),
  verifyAccountOwned: vi.fn(),
  isLinkedInSocialConnected: vi.fn(),
  isXSocialConnected: vi.fn(),
  isInstagramSocialConnected: vi.fn(),
  isRedditSocialConnected: vi.fn(),
  connectorTokenExpiresAt: vi.fn(),
  connectorScopes: vi.fn(),
  resolveOwnedComposioAccount: vi.fn(),
  getSecret: vi.fn(),
  secrets: {} as Record<string, string>,
  rails: { instagram: "composio", youtube: "composio", reddit: "composio" } as Record<string, string>,
}));

vi.mock("@/services/connectors/pipedream/api", () => ({
  listConnectedAccounts: m.listConnectedAccounts,
  verifyAccountOwned: m.verifyAccountOwned,
}));
vi.mock("@/services/connectors/linkedin-social/publish", () => ({
  isLinkedInSocialConnected: m.isLinkedInSocialConnected,
}));
vi.mock("@/services/connectors/x-social/publish", () => ({
  isXSocialConnected: m.isXSocialConnected,
}));
vi.mock("@/services/connectors/reddit-social/publish", () => ({
  isRedditSocialConnected: m.isRedditSocialConnected,
}));
vi.mock("@/services/connectors/instagram-social/publish", () => ({
  isInstagramSocialConnected: m.isInstagramSocialConnected,
}));
vi.mock("@/services/connectors/core/token", () => ({
  connectorTokenExpiresAt: m.connectorTokenExpiresAt,
  connectorScopes: m.connectorScopes,
}));
vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: m.resolveOwnedComposioAccount,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: m.getSecret }));
vi.mock("@zavi/shared", async (orig) => ({
  ...(await orig<typeof import("@zavi/shared")>()),
  railFor: (k: string) => m.rails[k] ?? "native",
}));

import {
  resolveSocialPublishAccount,
  verifySocialAccountAtPublish,
  isLinkedInSocialUsable,
  nativeChannelFor,
} from "../social-publish-account";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const PAST = new Date(Date.now() - 60_000);

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") fn.mockReset();
  m.rails = { instagram: "composio", youtube: "composio", reddit: "composio" };
  m.resolveOwnedComposioAccount.mockResolvedValue(null);
  m.isLinkedInSocialConnected.mockResolvedValue(true);
  m.isXSocialConnected.mockResolvedValue(true);
  m.isInstagramSocialConnected.mockResolvedValue(true);
  m.isRedditSocialConnected.mockResolvedValue(true);
  m.connectorTokenExpiresAt.mockResolvedValue(FUTURE);
  m.connectorScopes.mockResolvedValue(["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"]);
  m.listConnectedAccounts.mockResolvedValue([{ id: "apn_123" }]);
  m.verifyAccountOwned.mockResolvedValue(true);
  m.secrets = { "tiktok.access_token": "act.1", "tiktok.refresh_token": "rft.1" };
  m.getSecret.mockImplementation(async (_t: string, key: string) => {
    if (!(key in m.secrets)) throw new Error(`secret ${key} not found`);
    return m.secrets[key];
  });
  vi.stubEnv("TIKTOK_CLIENT_KEY", "ck");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "cs");
  vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.example.com");
});

describe("nativeChannelFor — the committed native map", () => {
  it("linkedin, linkedin_image, x, reddit and instagram_image are native; youtube_video and anything else are not", () => {
    expect(nativeChannelFor("linkedin")).not.toBeNull();
    expect(nativeChannelFor("linkedin_image")).not.toBeNull();
    expect(nativeChannelFor("x")).not.toBeNull();
    expect(nativeChannelFor("reddit")).not.toBeNull();
    expect(nativeChannelFor("instagram_image")).not.toBeNull();
    expect(nativeChannelFor("youtube_video")).toBeNull();
    expect(nativeChannelFor("mastodon")).toBeNull();
    expect(nativeChannelFor("myspace")).toBeNull();
  });

  it("is a plain-object lookup, not prototype-walking (no `constructor` surprises)", () => {
    expect(nativeChannelFor("constructor")).toBeNull();
    expect(nativeChannelFor("__proto__")).toBeNull();
  });
});

describe("x — native transport", () => {
  it("verifySocialAccountAtPublish: sentinel + connected → true, and never touches Pipedream", async () => {
    const ok = await verifySocialAccountAtPublish({
      tenantId: TENANT,
      channel: "x",
      accountId: "native",
      pipedreamAppSlug: "twitter",
      transport: "native",
    });
    expect(ok).toBe(true);
    expect(m.isXSocialConnected).toHaveBeenCalledWith(TENANT);
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });

  it("verifySocialAccountAtPublish: false when X is not connected", async () => {
    m.isXSocialConnected.mockResolvedValue(false);
    expect(
      await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "x", accountId: "native", pipedreamAppSlug: "twitter", transport: "native" }),
    ).toBe(false);
  });

  it("verifySocialAccountAtPublish: false for a non-sentinel account id on a native channel", async () => {
    expect(
      await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "x", accountId: "apn_9", pipedreamAppSlug: "twitter", transport: "native" }),
    ).toBe(false);
    expect(m.isXSocialConnected).not.toHaveBeenCalled();
  });

  it("x does NOT use the LinkedIn expiry check — its token refreshes", async () => {
    await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "x", accountId: "native", pipedreamAppSlug: "twitter", transport: "native" });
    expect(m.connectorTokenExpiresAt).not.toHaveBeenCalled();
  });
});

describe("x_image / x_video — native transport on the x_social connector", () => {
  for (const channel of ["x_image", "x_video"]) {
    it(`${channel}: resolves to native when X is connected with media.write`, async () => {
      const r = await resolveSocialPublishAccount(TENANT, channel);
      expect(r.transport).toBe("native");
      expect(r.accountId).toBe("native");
      expect(m.connectorScopes).toHaveBeenCalledWith(TENANT, "x_social");
    });

    it(`${channel}: publish-time check passes for the native sentinel`, async () => {
      expect(
        await verifySocialAccountAtPublish({ tenantId: TENANT, channel, accountId: "native", pipedreamAppSlug: "twitter", transport: "native" }),
      ).toBe(true);
    });

    it(`${channel}: an X connection without media.write is refused with a reconnect sentence`, async () => {
      m.connectorScopes.mockResolvedValue(["tweet.read", "tweet.write", "users.read", "offline.access"]);
      await expect(resolveSocialPublishAccount(TENANT, channel)).rejects.toThrow(/Reconnect X in Settings.*stage this post again/);
      expect(
        await verifySocialAccountAtPublish({ tenantId: TENANT, channel, accountId: "native", pipedreamAppSlug: "twitter", transport: "native" }),
      ).toBe(false);
    });

    it(`${channel}: X not connected is refused with the same sentence, never the generic slug`, async () => {
      m.isXSocialConnected.mockResolvedValue(false);
      await expect(resolveSocialPublishAccount(TENANT, channel)).rejects.toThrow(/Reconnect X in Settings/);
      await expect(resolveSocialPublishAccount(TENANT, channel)).rejects.not.toThrow(new RegExp(`no connected ${channel}`));
    });
  }

  it("the refusal never tells the founder to approve again (the card is terminal after approval)", async () => {
    m.connectorScopes.mockResolvedValue(["tweet.write"]);
    const err = await resolveSocialPublishAccount(TENANT, "x_image").catch((e: Error) => e.message);
    expect(err).not.toMatch(/approve again/i);
    expect(err).not.toMatch(/\u2014/);
  });

  it("unrecorded scopes are unknown, not missing — judged on connected alone", async () => {
    m.connectorScopes.mockResolvedValue(null);
    const r = await resolveSocialPublishAccount(TENANT, "x_image");
    expect(r.transport).toBe("native");
  });

  it("plain x text posts never consult scopes", async () => {
    await resolveSocialPublishAccount(TENANT, "x");
    expect(m.connectorScopes).not.toHaveBeenCalled();
  });
});

describe("isLinkedInSocialUsable — connected AND not expired", () => {
  it("true when connected with a future expiry", async () => {
    expect(await isLinkedInSocialUsable(TENANT)).toBe(true);
  });
  it("true when connected and no expiry is recorded", async () => {
    m.connectorTokenExpiresAt.mockResolvedValue(null);
    expect(await isLinkedInSocialUsable(TENANT)).toBe(true);
  });
  it("FALSE when the 60-day token has expired — no refresh exists, so refuse", async () => {
    m.connectorTokenExpiresAt.mockResolvedValue(PAST);
    expect(await isLinkedInSocialUsable(TENANT)).toBe(false);
  });
  it("false when not connected at all (does not even read expiry)", async () => {
    m.isLinkedInSocialConnected.mockResolvedValue(false);
    expect(await isLinkedInSocialUsable(TENANT)).toBe(false);
    expect(m.connectorTokenExpiresAt).not.toHaveBeenCalled();
  });
});

describe("resolveSocialPublishAccount — native channels", () => {
  it.each(["linkedin", "linkedin_image"])("%s resolves to native, never touching Pipedream", async (ch) => {
    const r = await resolveSocialPublishAccount(TENANT, ch);
    expect(r.transport).toBe("native");
    expect(r.accountId).toBe("native");
    expect(r.action.app_slug).toBe("linkedin");
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });

  it("refuses with a reconnect message when LinkedIn is not connected", async () => {
    m.isLinkedInSocialConnected.mockResolvedValue(false);
    await expect(resolveSocialPublishAccount(TENANT, "linkedin")).rejects.toThrow(/connect \(or reconnect\) LinkedIn/);
  });

  it("refuses when the token is expired even though a connection row exists", async () => {
    m.connectorTokenExpiresAt.mockResolvedValue(PAST);
    await expect(resolveSocialPublishAccount(TENANT, "linkedin_image")).rejects.toThrow(/reconnect/);
  });
});

describe("resolveSocialPublishAccount — reddit (Composio first since 2026-09-30, native backup)", () => {
  it("reddit resolves to the owned Composio account even when native works", async () => {
    m.resolveOwnedComposioAccount.mockResolvedValue({ tenant_id: TENANT, toolkit: "reddit", connected_account_id: "ca_rd" });
    const r = await resolveSocialPublishAccount(TENANT, "reddit");
    expect(r).toMatchObject({ transport: "composio", accountId: "ca_rd" });
    expect(m.resolveOwnedComposioAccount).toHaveBeenCalledWith(TENANT, "reddit");
    expect(m.isRedditSocialConnected).not.toHaveBeenCalled();
  });

  it("reddit composio row at publish: re-proven for the row's tenant and the row's account", async () => {
    const owned = { tenant_id: TENANT, toolkit: "reddit", connected_account_id: "ca_rd" };
    m.resolveOwnedComposioAccount.mockResolvedValue(owned);
    const base = { tenantId: TENANT, channel: "reddit", pipedreamAppSlug: "reddit", transport: "composio" as const };
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "ca_rd" })).toEqual(owned);
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "ca_other" })).toBe(false);
  });

  it("reddit with no Composio account resolves to native and never touches Pipedream", async () => {
    const r = await resolveSocialPublishAccount(TENANT, "reddit");
    expect(r.transport).toBe("native");
    expect(r.accountId).toBe("native");
    expect(r.action.app_slug).toBe("reddit");
    expect(m.isRedditSocialConnected).toHaveBeenCalledWith(TENANT);
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
    expect(m.connectorTokenExpiresAt).not.toHaveBeenCalled();
  });

  it("refuses with a connect message when Reddit is not connected", async () => {
    m.isRedditSocialConnected.mockResolvedValue(false);
    await expect(resolveSocialPublishAccount(TENANT, "reddit")).rejects.toThrow(/connect Reddit in Settings/);
  });

  it("reddit_comment rides the same Composio account, else the native connector", async () => {
    m.resolveOwnedComposioAccount.mockResolvedValueOnce({ tenant_id: TENANT, toolkit: "reddit", connected_account_id: "ca_rd" });
    expect(await resolveSocialPublishAccount(TENANT, "reddit_comment")).toMatchObject({ transport: "composio", accountId: "ca_rd" });
    expect(m.resolveOwnedComposioAccount).toHaveBeenCalledWith(TENANT, "reddit");
    expect(await resolveSocialPublishAccount(TENANT, "reddit_comment")).toMatchObject({ transport: "native" });
    m.isRedditSocialConnected.mockResolvedValue(false);
    await expect(resolveSocialPublishAccount(TENANT, "reddit_comment")).rejects.toThrow(/connect Reddit in Settings/);
  });

  it("x (enabled 2026-09-08) rides the native connector and refuses when X is not connected", async () => {
    m.isXSocialConnected.mockResolvedValueOnce(false);
    await expect(resolveSocialPublishAccount(TENANT, "x")).rejects.toThrow(/connect X in Settings/);
    m.isXSocialConnected.mockResolvedValueOnce(true);
    await expect(resolveSocialPublishAccount(TENANT, "x")).resolves.toMatchObject({ transport: "native" });
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
  });
});

describe("Pipedream rail — unreachable", () => {
  it("a queued pipedream row on a channel with no Composio app fails as disconnected, never calling Pipedream", async () => {
    const pd = { tenantId: TENANT, channel: "mastodon", accountId: "apn_123", pipedreamAppSlug: "mastodon", transport: "pipedream" as const };
    expect(await verifySocialAccountAtPublish(pd)).toBe(false);
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });

  it.each(["instagram_image", "youtube_video"])("a queued pipedream row on %s asks the founder to reconnect", async (ch) => {
    const r = await verifySocialAccountAtPublish({ tenantId: TENANT, channel: ch, accountId: "apn_1", pipedreamAppSlug: "x", transport: "pipedream" });
    expect(r).toBe("reconnect_required");
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });

  it("a channel with no Composio toolkit and no native connection refuses without Pipedream", async () => {
    m.isXSocialConnected.mockResolvedValue(false);
    await expect(resolveSocialPublishAccount(TENANT, "x")).rejects.toThrow(/connect X/);
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
    expect(m.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });
});

describe("verifySocialAccountAtPublish — the worker's exec-time recheck", () => {
  it("native: true only for the sentinel account AND a usable token", async () => {
    const base = { tenantId: TENANT, channel: "linkedin", pipedreamAppSlug: "linkedin", transport: "native" as const };
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "native" })).toBe(true);
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "apn_123" })).toBe(false);
    m.connectorTokenExpiresAt.mockResolvedValue(PAST);
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "native" })).toBe(false);
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });

  it("reddit (native): sentinel + connected → true; connector down → false; never Pipedream", async () => {
    const base = { tenantId: TENANT, channel: "reddit", pipedreamAppSlug: "reddit", transport: "native" as const };
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "native" })).toBe(true);
    m.isRedditSocialConnected.mockResolvedValue(false);
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "native" })).toBe(false);
    expect(m.verifyAccountOwned).not.toHaveBeenCalled();
  });
});

describe("instagram_image (Composio first, native backup) + youtube_video (Composio only)", () => {
  const OWNED_IG = { tenant_id: TENANT, toolkit: "instagram", connected_account_id: "ca_ig" };
  const OWNED_YT = { tenant_id: TENANT, toolkit: "youtube", connected_account_id: "ca_yt" };

  it("instagram_image resolves to the owned Composio account even when native works; Pipedream never called", async () => {
    m.resolveOwnedComposioAccount.mockResolvedValue(OWNED_IG);
    const r = await resolveSocialPublishAccount(TENANT, "instagram_image");
    expect(r).toMatchObject({ transport: "composio", accountId: "ca_ig" });
    expect(m.resolveOwnedComposioAccount).toHaveBeenCalledWith(TENANT, "instagram");
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
  });

  it("youtube_video resolves to the owned Composio account", async () => {
    m.resolveOwnedComposioAccount.mockResolvedValue(OWNED_YT);
    const r = await resolveSocialPublishAccount(TENANT, "youtube_video");
    expect(r).toMatchObject({ transport: "composio", accountId: "ca_yt" });
    expect(m.resolveOwnedComposioAccount).toHaveBeenCalledWith(TENANT, "youtube");
  });

  it("instagram_image: no Composio account + native usable → native backup", async () => {
    const r = await resolveSocialPublishAccount(TENANT, "instagram_image");
    expect(r).toMatchObject({ transport: "native", accountId: "native" });
    expect(m.listConnectedAccounts).not.toHaveBeenCalled();
  });

  it("instagram_image: neither connected → the Settings message", async () => {
    m.isInstagramSocialConnected.mockResolvedValue(false);
    await expect(resolveSocialPublishAccount(TENANT, "instagram_image")).rejects.toThrow(/connect Instagram in Settings/);
  });

  it("youtube_video: no Composio account → the Settings message (no native backup)", async () => {
    await expect(resolveSocialPublishAccount(TENANT, "youtube_video")).rejects.toThrow(/connect YouTube in Settings/);
  });

  it("with Instagram flipped back to its native rail, Composio is never consulted", async () => {
    m.rails = {};
    const r = await resolveSocialPublishAccount(TENANT, "instagram_image");
    expect(r.transport).toBe("native");
    expect(m.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });

  it("verify composio: returns the owned account only when it is the row's account for this tenant", async () => {
    m.resolveOwnedComposioAccount.mockResolvedValue(OWNED_IG);
    const base = { tenantId: TENANT, channel: "instagram_image", pipedreamAppSlug: "instagram_business", transport: "composio" as const };
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "ca_ig" })).toBe(OWNED_IG);
    expect(m.resolveOwnedComposioAccount).toHaveBeenCalledWith(TENANT, "instagram");
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "ca_other" })).toBe(false);
    m.resolveOwnedComposioAccount.mockResolvedValue(null);
    expect(await verifySocialAccountAtPublish({ ...base, accountId: "ca_ig" })).toBe(false);
  });

  it("verify composio on a channel without a Composio toolkit → false", async () => {
    expect(await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "linkedin", accountId: "ca_1", pipedreamAppSlug: "linkedin", transport: "composio" })).toBe(false);
    expect(m.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });

  it("verify native on a Composio-toolkit channel is judged by the native sentinel", async () => {
    expect(await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "instagram_image", accountId: "native", pipedreamAppSlug: "instagram_business", transport: "native" })).toBe(true);
    expect(await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "youtube_video", accountId: "native", pipedreamAppSlug: "youtube_data_api", transport: "native" })).toBe(false);
    expect(await verifySocialAccountAtPublish({ tenantId: TENANT, channel: "instagram_image", accountId: "apn_9", pipedreamAppSlug: "instagram_business", transport: "native" })).toBe(false);
    expect(m.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });
});

describe("tiktok_video — native transport needs the app keys and a refreshable token", () => {
  const base = { tenantId: TENANT, channel: "tiktok_video", accountId: "native", pipedreamAppSlug: "tiktok", transport: "native" as const };

  it("usable with the app keys, an access token and a refresh token", async () => {
    expect(await verifySocialAccountAtPublish(base)).toBe(true);
    expect(await resolveSocialPublishAccount(TENANT, "tiktok_video")).toMatchObject({ transport: "native", accountId: "native" });
  });

  it("not usable when the access token is there but the refresh token is gone", async () => {
    delete m.secrets["tiktok.refresh_token"];
    expect(await verifySocialAccountAtPublish(base)).toBe(false);
    await expect(resolveSocialPublishAccount(TENANT, "tiktok_video")).rejects.toThrow("connect TikTok in Settings first");
  });

  it("not usable when the server has no TikTok client key, even with both tokens", async () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    expect(await verifySocialAccountAtPublish(base)).toBe(false);
    await expect(resolveSocialPublishAccount(TENANT, "tiktok_video")).rejects.toThrow("connect TikTok in Settings first");
  });

  it("not usable when the server has no TikTok client secret, even with both tokens", async () => {
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    expect(await verifySocialAccountAtPublish(base)).toBe(false);
  });
});
