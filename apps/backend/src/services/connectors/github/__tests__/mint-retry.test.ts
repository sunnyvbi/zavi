
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(_table: string) {
      const b: Record<string, unknown> = {
        update() {
          return b;
        },
        eq() {
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
  _setMintRetryBaseMsForTests(1);
});

type ScriptedResponse =
  | { kind: "status"; status: number; body?: string }
  | { kind: "throw"; error: Error };

function mockScript(script: ScriptedResponse[]): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = vi.fn(async () => {
    const step = script[calls] ?? script[script.length - 1];
    calls += 1;
    if (step.kind === "throw") throw step.error;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => step.body ?? `{"status":${step.status}}`,
      json: async () =>
        step.status >= 200 && step.status < 300
          ? { token: "tok-abc-123", expires_at: "2030-01-01T00:00:00Z" }
          : {},
    };
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

describe("mintInstallationToken — retry policy (HTTP + network)", () => {
  it("404 → throws with readable `HTTP 404` message immediately (no retry)", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 404, body: '{"message":"Not Found"}' },
    ]);
    await expect(
      mintInstallationToken({ tenant_id: "t1", installation_id: 999 }),
    ).rejects.toThrow(/mintInstallationToken HTTP 404/);
    expect(calls()).toBe(1);
  });

  it("401 → retries once with fresh JWT (the 'refresh'), then throws `HTTP 401`", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 401, body: '{"message":"Bad credentials"}' },
      { kind: "status", status: 401, body: '{"message":"Bad credentials"}' },
    ]);
    await expect(
      mintInstallationToken({ tenant_id: "t1", installation_id: 999 }),
    ).rejects.toThrow(/mintInstallationToken HTTP 401/);
    expect(calls()).toBe(2);
  });

  it("401 → refresh attempt SUCCEEDS on 2nd try, returns token", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 401, body: '{"message":"Bad credentials"}' },
      { kind: "status", status: 200 },
    ]);
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok).toBe("tok-abc-123");
    expect(calls()).toBe(2);
  });

  it("500 → retries up to 3 attempts then throws readable `HTTP 500`", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 500, body: "internal" },
      { kind: "status", status: 500, body: "internal" },
      { kind: "status", status: 500, body: "internal" },
    ]);
    await expect(
      mintInstallationToken({ tenant_id: "t1", installation_id: 999 }),
    ).rejects.toThrow(/mintInstallationToken HTTP 500/);
    expect(calls()).toBe(3);
  });

  it("503 → 200 on retry returns token (transient recovery)", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 503 },
      { kind: "status", status: 200 },
    ]);
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok).toBe("tok-abc-123");
    expect(calls()).toBe(2);
  });

  it("429 rate-limit → retries up to 3 attempts (transient)", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 429 },
      { kind: "status", status: 429 },
      { kind: "status", status: 200 },
    ]);
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok).toBe("tok-abc-123");
    expect(calls()).toBe(3);
  });

  it("network error → retries up to 3 attempts then throws readable `network error` message", async () => {
    const { calls } = mockScript([
      { kind: "throw", error: new Error("ECONNRESET") },
      { kind: "throw", error: new Error("ECONNRESET") },
      { kind: "throw", error: new Error("ECONNRESET") },
    ]);
    await expect(
      mintInstallationToken({ tenant_id: "t1", installation_id: 999 }),
    ).rejects.toThrow(/network error after 3 attempts/i);
    expect(calls()).toBe(3);
  });

  it("network error → 200 on retry returns token", async () => {
    const { calls } = mockScript([
      { kind: "throw", error: new Error("ETIMEDOUT") },
      { kind: "status", status: 200 },
    ]);
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok).toBe("tok-abc-123");
    expect(calls()).toBe(2);
  });

  it("403 secondary rate-limit → throws immediately, NO retry", async () => {
    const { calls } = mockScript([
      { kind: "status", status: 403, body: "secondary rate-limit exceeded" },
    ]);
    await expect(
      mintInstallationToken({ tenant_id: "t1", installation_id: 999 }),
    ).rejects.toThrow(/mintInstallationToken HTTP 403/);
    expect(calls()).toBe(1);
  });

  it("200 → returns token, NO retry, no cache miss on immediate second call", async () => {
    const { calls } = mockScript([{ kind: "status", status: 200 }]);
    const tok = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok).toBe("tok-abc-123");
    expect(calls()).toBe(1);
    const tok2 = await mintInstallationToken({ tenant_id: "t1", installation_id: 999 });
    expect(tok2).toBe("tok-abc-123");
    expect(calls()).toBe(1);
  });
});
