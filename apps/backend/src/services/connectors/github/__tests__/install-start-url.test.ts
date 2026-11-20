import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";

let pem: string;
beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  process.env.GITHUB_APP_ID = "3659938";
  process.env.GITHUB_APP_PRIVATE_KEY = pem;
  process.env.GITHUB_APP_SLUG = "praxis-cto-engineer";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("githubAppInstallStartUrl — self-healing against App rename", () => {
  it("uses the LIVE html_url from GET /app (ignores the stale env slug)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ html_url: "https://github.com/apps/zavi-engineer" }),
      })),
    );
    vi.resetModules();
    const { githubAppInstallStartUrl } = await import("../oauth");
    const url = await githubAppInstallStartUrl("STATE123");
    expect(url).toBe(
      "https://github.com/apps/zavi-engineer/installations/new?state=STATE123",
    );
    expect(url).not.toContain("praxis-cto-engineer");
  });

  it("falls back to the env slug when GET /app fails (transient GitHub hiccup)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.resetModules();
    const { githubAppInstallStartUrl } = await import("../oauth");
    const url = await githubAppInstallStartUrl("S");
    expect(url).toBe(
      "https://github.com/apps/praxis-cto-engineer/installations/new?state=S",
    );
  });
});
