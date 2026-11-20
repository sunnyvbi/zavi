import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";

type Captured = {
  table?: string;
  update?: unknown;
  eqs: Array<[string, unknown]>;
  calls: number;
};
let captured: Captured = { eqs: [], calls: 0 };

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      captured.table = table;
      captured.calls += 1;
      const b: Record<string, unknown> = {
        update(obj: unknown) {
          captured.update = obj;
          return b;
        },
        eq(col: string, val: unknown) {
          captured.eqs.push([col, val]);
          return b;
        },
        then(resolve: (v: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return b;
    },
  }),
}));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: async () => [],
}));

import {
  mintInstallationToken,
  _resetTokenCacheForTests,
  _setMintRetryBaseMsForTests,
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
  _setMintRetryBaseMsForTests(200);
});

beforeEach(() => {
  _resetTokenCacheForTests();
  captured = { eqs: [], calls: 0 };
  _setMintRetryBaseMsForTests(1);
});

function mockMint(status: number) {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status,
    text: async () => `{"message":"Not Found","status":"${status}"}`,
  })) as unknown as typeof fetch;
}

describe("mintInstallationToken — dead-install self-heal", () => {
  it("HTTP 404 disables the tenant's github MCP, then still throws the mint error", async () => {
    mockMint(404);
    await expect(
      mintInstallationToken({ tenant_id: "tenant-x", installation_id: 999 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(captured.table).toBe("tenant_mcp_servers");
    expect(captured.update).toEqual({ enabled: false });
    expect(captured.eqs).toContainEqual(["tenant_id", "tenant-x"]);
    expect(captured.eqs).toContainEqual(["server_id", "github"]);
  });

  it("HTTP 401 (App-global) does NOT disable any connector", async () => {
    mockMint(401);
    await expect(
      mintInstallationToken({ tenant_id: "tenant-y", installation_id: 999 }),
    ).rejects.toThrow(/HTTP 401/);
    expect(captured.calls).toBe(0);
  });

  it("HTTP 403 (secondary rate-limit) does NOT disable any connector", async () => {
    mockMint(403);
    await expect(
      mintInstallationToken({ tenant_id: "tenant-z", installation_id: 999 }),
    ).rejects.toThrow(/HTTP 403/);
    expect(captured.calls).toBe(0);
  });
});
