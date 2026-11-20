import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const QUOTA_403 = JSON.stringify({
  error: { type: "platform-feature-disabled", message: "Monthly usage hard limit exceeded" },
});
const AUTH_403 = JSON.stringify({
  error: { type: "insufficient-permissions", message: "Insufficient permissions for this token" },
});

function stubApify(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("api.apify.com")) {
        return new Response(body, { status });
      }
      return new Response("", { status: 200 });
    }),
  );
}

describe("apify quota exhaustion is not an auth failure", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env.APIFY_TOKEN = "test-token-not-broken";
  });

  it("maps the live 403 quota body to apify_quota_exhausted, never apify_auth_failed", async () => {
    stubApify(403, QUOTA_403);
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "scrape_tiktok", { username: "turo" })) as {
      is_error: boolean;
      content: string;
    };

    expect(res.is_error).toBe(true);
    expect(res.content).not.toMatch(/APIFY_TOKEN/);
    expect(res.content).not.toMatch(/apify_auth_failed/);
    expect(res.content).toMatch(/apify_quota_exhausted/);
  });

  it("still reports a real permissions 403 as an auth failure", async () => {
    stubApify(403, AUTH_403);
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "scrape_tiktok", { username: "turo" })) as {
      is_error: boolean;
      content: string;
    };

    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/apify_auth_failed/);
  });

  it("a 401 is still an auth failure", async () => {
    stubApify(401, AUTH_403);
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "scrape_tiktok", { username: "turo" })) as {
      is_error: boolean;
      content: string;
    };

    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/apify_auth_failed/);
  });
});
