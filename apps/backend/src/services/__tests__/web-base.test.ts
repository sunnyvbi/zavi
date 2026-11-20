
import { describe, it, expect, afterEach, vi } from "vitest";
import { webBaseUrl, approvalsUrl, workspaceUrl, decisionHomeUrl, growthUrl, needsYouUrl, resetWebBaseWarningForTests } from "../web-base";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("webBaseUrl", () => {
  it("refuses to run in production without WEB_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "");
    vi.stubEnv("WEB_ORIGIN", "https://www.zaviagent.com");
    expect(() => webBaseUrl()).toThrow(/WEB_BASE_URL/);
  });

  it("refuses a non-https or non-origin value in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const bad of ["http://localhost:3000", "https://www.zaviagent.com?preview=1", "https://www.zaviagent.com/app"]) {
      vi.stubEnv("WEB_BASE_URL", bad);
      expect(() => webBaseUrl()).toThrow(/https origin/);
    }
  });

  it("uses the configured value, trimmed and without a trailing slash", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", " https://www.zaviagent.com/ ");
    expect(webBaseUrl()).toBe("https://www.zaviagent.com");
    expect(workspaceUrl()).toBe("https://www.zaviagent.com/workspace");
    expect(approvalsUrl()).toBe("https://www.zaviagent.com/workspace?tab=needs-you");
  });

  it("opens one decision where it lives (2026-10-17)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "https://www.zaviagent.com");
    const id = "11111111-2222-4333-8444-555555555555";
    expect(decisionHomeUrl({ id, decision_class: "google_ads.update_campaign_budget" }, "t1")).toBe(
      `https://www.zaviagent.com/workspace?tab=growth-strategy&company=t1&decision=${id}`,
    );
    expect(decisionHomeUrl({ id, decision_class: "pm.ticket" })).toBe(`https://www.zaviagent.com/workspace?tab=needs-you&decision=${id}`);
    expect(decisionHomeUrl({ id, decision_class: "seo.publish", home_channel: "seo" }, "t1")).toBe(
      `https://www.zaviagent.com/workspace?tab=channels&channel=seo&action=${id}&company=t1`,
    );
    expect(decisionHomeUrl({ id, decision_class: "pm.ticket", home_channel: "nope" })).toContain("tab=needs-you");
    expect(growthUrl()).toBe("https://www.zaviagent.com/workspace?tab=growth-strategy");
    expect(needsYouUrl("a b")).toBe("https://www.zaviagent.com/workspace?tab=needs-you&company=a%20b");
  });

  it("reads a bare host as its https origin (the prod value that crashed boot)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "www.zaviagent.com");
    expect(webBaseUrl()).toBe("https://www.zaviagent.com");
    expect(workspaceUrl()).toBe("https://www.zaviagent.com/workspace");
  });

  it("still refuses a bare host with a path in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "www.zaviagent.com/app");
    expect(() => webBaseUrl()).toThrow(/https origin/);
  });

  it("defaults to localhost outside production when unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_BASE_URL", "");
    expect(webBaseUrl()).toBe("http://localhost:3000");
  });
});

describe("webBaseUrl local fallback warning", () => {
  it("warns exactly once, naming WEB_BASE_URL, however many links are built", () => {
    resetWebBaseWarningForTests();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_BASE_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(webBaseUrl()).toBe("http://localhost:3000");
    workspaceUrl();
    approvalsUrl("t1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("WEB_BASE_URL");
    expect(String(warn.mock.calls[0][0])).toContain("http://localhost:3000");
    warn.mockRestore();
  });

  it("does not warn when WEB_BASE_URL is set locally, or in production", () => {
    resetWebBaseWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_BASE_URL", "http://localhost:3010");
    expect(workspaceUrl()).toBe("http://localhost:3010/workspace");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "https://www.zaviagent.com");
    expect(webBaseUrl()).toBe("https://www.zaviagent.com");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
