import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

const getScopedRepoFullNames = vi.fn(async (_t: string): Promise<string[]> => []);
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: (t: string) => getScopedRepoFullNames(t),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import {
  mintInstallationToken,
  _resetTokenCacheForTests,
} from "../oauth";

const realFetch = globalThis.fetch;
let prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  prevEnv = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
  };
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
  process.env.GITHUB_APP_SLUG = "zavi-engineer";
});

afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
});

function mockAccessTokenOk() {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      token: "ghs_minted",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetTokenCacheForTests();
  getScopedRepoFullNames.mockReset();
  globalThis.fetch = realFetch;
});

describe("mintInstallationToken — repo-scoping backstop", () => {
  it("REJECTS a per-repo mint for a repo NOT in the scoped set (no GitHub call)", async () => {
    getScopedRepoFullNames.mockResolvedValue(["acme/allowed"]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      mintInstallationToken({
        tenant_id: "t1",
        installation_id: 9,
        repo_full_name: "acme/scoped-out",
      }),
    ).rejects.toThrow(/scoped repositories/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS a per-repo mint for a repo IN the scoped set", async () => {
    getScopedRepoFullNames.mockResolvedValue(["acme/allowed"]);
    mockAccessTokenOk();
    const tok = await mintInstallationToken({
      tenant_id: "t1",
      installation_id: 9,
      repo_full_name: "acme/allowed",
    });
    expect(tok).toBe("ghs_minted");
    expect(getScopedRepoFullNames).toHaveBeenCalledWith("t1");
  });

  it("allow_unscoped:true BYPASSES the backstop (provisioned/umbrella opt-in)", async () => {
    mockAccessTokenOk();
    const tok = await mintInstallationToken({
      tenant_id: "t1",
      installation_id: 9,
      repo_full_name: "praxis-org/umbrella-xyz",
      allow_unscoped: true,
    });
    expect(tok).toBe("ghs_minted");
    expect(getScopedRepoFullNames).not.toHaveBeenCalled();
  });

  it("installation-wide mint (no repo_full_name) is NOT scope-checked", async () => {
    mockAccessTokenOk();
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 9 });
    expect(tok).toBe("ghs_minted");
    expect(getScopedRepoFullNames).not.toHaveBeenCalled();
  });

  it("empty scoped set (no connected repos / outage) fails CLOSED for a per-repo mint", async () => {
    getScopedRepoFullNames.mockResolvedValue([]);
    await expect(
      mintInstallationToken({
        tenant_id: "t1",
        installation_id: 9,
        repo_full_name: "acme/web",
      }),
    ).rejects.toThrow(/scoped repositories/i);
  });
});
