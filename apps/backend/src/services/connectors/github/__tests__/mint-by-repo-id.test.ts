import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: async () => ["acme/old-name", "acme/web", "acme/other"],
}));

const row = vi.hoisted(() => ({
  data: null as null | { repo_ids: number[]; repo_full_names: string[] },
  error: null as null | { message: string },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: row.data, error: row.error }),
      };
      return b;
    },
  }),
}));

import { mintInstallationToken, _resetTokenCacheForTests } from "../oauth";

const realFetch = globalThis.fetch;
let prevEnv: Record<string, string | undefined> = {};
let sentBody: unknown;

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

beforeEach(() => {
  _resetTokenCacheForTests();
  sentBody = undefined;
  row.data = { repo_ids: [111, 222], repo_full_names: ["acme/old-name", "acme/web"] };
  row.error = null;
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    sentBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return {
      ok: true,
      json: async () => ({
        token: "ghs_minted",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    };
  }) as unknown as typeof fetch;
});

const mint = (repo_full_name: string) =>
  mintInstallationToken({ tenant_id: "t1", installation_id: 9, repo_full_name });

describe("mintInstallationToken scopes by repo ID", () => {
  it("sends repository_ids for a connected repo, even under a stale (renamed) name", async () => {
    await mint("acme/old-name");
    expect(sentBody).toEqual({ repository_ids: [111] });
  });

  it("falls back to the repo name when the repo has no stored ID", async () => {
    await mint("acme/other");
    expect(sentBody).toEqual({ repositories: ["other"] });
  });

  it("falls back to the repo name when the connector read fails", async () => {
    row.data = null;
    row.error = { message: "boom" };
    await mint("acme/web");
    expect(sentBody).toEqual({ repositories: ["web"] });
  });
});
