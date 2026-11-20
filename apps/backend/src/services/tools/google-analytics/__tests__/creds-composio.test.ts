import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  resolveOwnedComposioAccount: vi.fn(),
  hasComposioSignIn: vi.fn(),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.getSecret }));
vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: mocks.resolveOwnedComposioAccount,
  hasComposioSignIn: mocks.hasComposioSignIn,
}));

import { googleAnalyticsCreds } from "../_client";
import { GOOGLE_ANALYTICS_VAULT_KEYS } from "../keys";

const ACCOUNT = { tenant_id: "t-1", toolkit: "google_analytics", connected_account_id: "ca_1", auth_config_id: "ac_1" };

function vault(values: Record<string, string>) {
  mocks.getSecret.mockImplementation(async (_t: string, key: string) => values[key] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasComposioSignIn.mockResolvedValue(false);
  delete process.env.GOOGLE_ANALYTICS_CLIENT_ID;
  delete process.env.GOOGLE_ANALYTICS_CLIENT_SECRET;
  delete process.env.GOOGLE_ADS_CLIENT_ID;
  delete process.env.GOOGLE_ADS_CLIENT_SECRET;
});

describe("googleAnalyticsCreds on the Composio rail (empty refresh token + property)", () => {
  it("returns the property with the Composio account as auth source, no native env needed", async () => {
    vault({ [GOOGLE_ANALYTICS_VAULT_KEYS.property_id]: "properties/123456" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(ACCOUNT);

    const creds = await googleAnalyticsCreds("t-1");

    expect(creds).toEqual({ property_id: "123456", auth: { kind: "composio", account: ACCOUNT } });
    expect(mocks.resolveOwnedComposioAccount).toHaveBeenCalledWith("t-1", "google_analytics");
  });

  it("throws google_analytics_not_connected when no Composio account backs the selection", async () => {
    vault({ [GOOGLE_ANALYTICS_VAULT_KEYS.property_id]: "123456" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);
    await expect(googleAnalyticsCreds("t-1")).rejects.toMatchObject({ code: "google_analytics_not_connected" });
  });

  it("a failed account read is a retryable unavailable, never not_connected or raw", async () => {
    vault({ [GOOGLE_ANALYTICS_VAULT_KEYS.property_id]: "123456" });
    mocks.resolveOwnedComposioAccount.mockRejectedValue(new Error("db down"));
    await expect(googleAnalyticsCreds("t-1")).rejects.toMatchObject({ code: "google_analytics_unavailable" });
  });

  it("native path is untouched: a stored refresh token never consults Composio", async () => {
    vault({
      [GOOGLE_ANALYTICS_VAULT_KEYS.refresh_token]: "1//native-refresh",
      [GOOGLE_ANALYTICS_VAULT_KEYS.property_id]: "123456",
    });
    await expect(googleAnalyticsCreds("t-1")).rejects.toMatchObject({ code: "google_analytics_not_configured" });
    expect(mocks.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });

  it("nothing stored at all still reports not connected (native semantics kept)", async () => {
    vault({});
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    await expect(googleAnalyticsCreds("t-1")).rejects.toMatchObject({ code: "google_analytics_not_connected" });
    expect(mocks.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });
});

describe("googleAnalyticsCreds: Google sign-in done, no property picked", () => {
  it("keeps google_analytics_not_connected with the new words", async () => {
    vault({});
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    mocks.hasComposioSignIn.mockResolvedValue(true);
    const err = await googleAnalyticsCreds("t-1").then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as { code: string; message: string; unblockers?: string[] });
    expect(err).toMatchObject({ code: "google_analytics_not_connected" });
    expect(err.message).toMatch(/^Google sign-in worked, but no .* property is set up for this workspace\. Connect again in Settings and pick one/);
    expect(mocks.hasComposioSignIn).toHaveBeenCalledWith("t-1", "google_analytics");
    expect(mocks.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });

  it("no sign-in, or an unreadable one, keeps the plain not-connected words", async () => {
    vault({});
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    for (const signIn of [false, new Error("db down")]) {
      if (signIn instanceof Error) mocks.hasComposioSignIn.mockRejectedValue(signIn);
      else mocks.hasComposioSignIn.mockResolvedValue(signIn);
      const err = await googleAnalyticsCreds("t-1").then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as { code: string; message: string });
      expect(err).toMatchObject({ code: "google_analytics_not_connected" });
      expect(err.message).not.toContain("sign-in worked");
    }
  });

  it("a picked property never asks about the sign-in", async () => {
    vault({ [GOOGLE_ANALYTICS_VAULT_KEYS.property_id]: "123456" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);
    await expect(googleAnalyticsCreds("t-1")).rejects.toMatchObject({ code: "google_analytics_not_connected" });
    expect(mocks.hasComposioSignIn).not.toHaveBeenCalled();
  });
});
