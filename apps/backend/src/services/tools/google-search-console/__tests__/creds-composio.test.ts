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

import { googleSearchConsoleCreds } from "../_client";
import { GOOGLE_SEARCH_CONSOLE_VAULT_KEYS } from "../keys";

const ACCOUNT = { tenant_id: "t-1", toolkit: "google_search_console", connected_account_id: "ca_2", auth_config_id: "ac_2" };

function vault(values: Record<string, string>) {
  mocks.getSecret.mockImplementation(async (_t: string, key: string) => values[key] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasComposioSignIn.mockResolvedValue(false);
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  delete process.env.GOOGLE_ADS_CLIENT_ID;
  delete process.env.GOOGLE_ADS_CLIENT_SECRET;
});

describe("googleSearchConsoleCreds on the Composio rail", () => {
  it("returns the site with the Composio account as auth source", async () => {
    vault({ [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url]: "sc-domain:example.com" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(ACCOUNT);

    const creds = await googleSearchConsoleCreds("t-1");

    expect(creds).toEqual({ site_url: "sc-domain:example.com", auth: { kind: "composio", account: ACCOUNT } });
    expect(mocks.resolveOwnedComposioAccount).toHaveBeenCalledWith("t-1", "google_search_console");
  });

  it("throws not_connected when no Composio account backs the selection", async () => {
    vault({ [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url]: "sc-domain:example.com" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);
    await expect(googleSearchConsoleCreds("t-1")).rejects.toMatchObject({ code: "google_search_console_not_connected" });
  });

  it("a failed account read is a retryable unavailable, never not_connected", async () => {
    vault({ [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url]: "sc-domain:example.com" });
    mocks.resolveOwnedComposioAccount.mockRejectedValue(new Error("db down"));
    await expect(googleSearchConsoleCreds("t-1")).rejects.toMatchObject({ code: "google_search_console_unavailable" });
  });

  it("native path untouched: a stored refresh token never consults Composio", async () => {
    vault({
      [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.refresh_token]: "1//native-refresh",
      [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url]: "sc-domain:example.com",
    });
    await expect(googleSearchConsoleCreds("t-1")).rejects.toMatchObject({ code: "google_search_console_not_configured" });
    expect(mocks.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });
});

describe("googleSearchConsoleCreds: Google sign-in done, no site picked", () => {
  it("keeps google_search_console_not_connected with the new words", async () => {
    vault({});
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    mocks.hasComposioSignIn.mockResolvedValue(true);
    const err = await googleSearchConsoleCreds("t-1").then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as { code: string; message: string; unblockers?: string[] });
    expect(err).toMatchObject({ code: "google_search_console_not_connected" });
    expect(err.message).toMatch(/^Google sign-in worked, but no .* site is set up for this workspace\. Connect again in Settings and pick one/);
    expect(mocks.hasComposioSignIn).toHaveBeenCalledWith("t-1", "google_search_console");
    expect(mocks.resolveOwnedComposioAccount).not.toHaveBeenCalled();
  });

  it("no sign-in, or an unreadable one, keeps the plain not-connected words", async () => {
    vault({});
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    for (const signIn of [false, new Error("db down")]) {
      if (signIn instanceof Error) mocks.hasComposioSignIn.mockRejectedValue(signIn);
      else mocks.hasComposioSignIn.mockResolvedValue(signIn);
      const err = await googleSearchConsoleCreds("t-1").then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as { code: string; message: string });
      expect(err).toMatchObject({ code: "google_search_console_not_connected" });
      expect(err.message).not.toContain("sign-in worked");
    }
  });

  it("a picked site never asks about the sign-in", async () => {
    vault({ [GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url]: "sc-domain:example.com" });
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);
    await expect(googleSearchConsoleCreds("t-1")).rejects.toMatchObject({ code: "google_search_console_not_connected" });
    expect(mocks.hasComposioSignIn).not.toHaveBeenCalled();
  });
});
