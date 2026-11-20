import { describe, it, expect } from "vitest";
import { sanitizeDiscoveryError } from "@/services/team-discovery/types";
import { __test as ghTest } from "@/services/team-discovery/github";

describe("sanitizeDiscoveryError — codex C8", () => {
  it("never leaks message body or URL into the persisted error shape", () => {
    const err = new Error("github: https://api.github.com/orgs/secret-org/members returned 'private repo blocked' for token ghp_REDACTED");
    const out = sanitizeDiscoveryError("github", err);
    expect(Object.keys(out)).toEqual(expect.arrayContaining(["provider", "code"]));
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect(JSON.stringify(out)).not.toContain("api.github.com");
    expect(JSON.stringify(out)).not.toContain("private repo");
  });

  it("maps not_connected pattern", () => {
    expect(sanitizeDiscoveryError("slack", new Error("Slack is not connected"))).toEqual({
      provider: "slack",
      code: "not_connected",
    });
  });

  it("maps 401/403 to auth_failed", () => {
    expect(sanitizeDiscoveryError("jira", { status: 401 })).toEqual({
      provider: "jira",
      code: "auth_failed",
      status: 401,
    });
    expect(sanitizeDiscoveryError("jira", { response: { status: 403 } })).toEqual({
      provider: "jira",
      code: "auth_failed",
      status: 403,
    });
  });

  it("maps 429 to rate_limited", () => {
    expect(sanitizeDiscoveryError("slack", { status: 429 })).toEqual({
      provider: "slack",
      code: "rate_limited",
      status: 429,
    });
  });

  it("maps generic http to http_<status>", () => {
    expect(sanitizeDiscoveryError("github", { status: 502 })).toEqual({
      provider: "github",
      code: "http_502",
      status: 502,
    });
  });

  it("parses http_NNN from message string when no .status is set", () => {
    expect(sanitizeDiscoveryError("jira", new Error("jira http_401"))).toEqual({
      provider: "jira",
      code: "auth_failed",
      status: 401,
    });
    expect(sanitizeDiscoveryError("github", new Error("github http_500"))).toEqual({
      provider: "github",
      code: "http_500",
      status: 500,
    });
    expect(sanitizeDiscoveryError("slack", new Error("slack http_429 rate limited"))).toEqual({
      provider: "slack",
      code: "rate_limited",
      status: 429,
    });
  });

  it("falls back to 'unexpected' when no status/message hint", () => {
    expect(sanitizeDiscoveryError("github", new Error("weird"))).toEqual({
      provider: "github",
      code: "unexpected",
    });
  });
});

describe("github.isBotLogin — codex C10", () => {
  it("detects type=Bot", () => {
    expect(ghTest.isBotLogin("alice", "Bot")).toBe(true);
  });

  it("detects [bot] suffix regardless of type", () => {
    expect(ghTest.isBotLogin("dependabot[bot]", "User")).toBe(true);
    expect(ghTest.isBotLogin("my-custom-app[bot]", "User")).toBe(true);
    expect(ghTest.isBotLogin("MY-APP[BOT]", "User")).toBe(true);
  });

  it("matches static allowlist", () => {
    expect(ghTest.isBotLogin("dependabot", "User")).toBe(true);
    expect(ghTest.isBotLogin("renovate", "User")).toBe(true);
    expect(ghTest.isBotLogin("github-actions", "User")).toBe(true);
    expect(ghTest.isBotLogin("vercel", "User")).toBe(true);
  });

  it("does NOT misclassify real humans", () => {
    expect(ghTest.isBotLogin("alice-dev", "User")).toBe(false);
    expect(ghTest.isBotLogin("bob_eng", "User")).toBe(false);
    expect(ghTest.isBotLogin("rravi149", "User")).toBe(false);
  });

  it("static allowlist matches the [bot]-stripped stem", () => {
    expect(ghTest.isBotLogin("dependabot[bot]", "User")).toBe(true);
    expect(ghTest.isBotLogin("snyk-bot[bot]", "User")).toBe(true);
  });
});
