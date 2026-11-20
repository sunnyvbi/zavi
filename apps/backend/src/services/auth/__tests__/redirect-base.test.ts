import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAuthRedirectBase } from "../redirect-base";

describe("resolveAuthRedirectBase", () => {
  const saved = { base: process.env.WEB_BASE_URL, origin: process.env.WEB_ORIGIN };
  beforeEach(() => {
    delete process.env.WEB_BASE_URL;
    delete process.env.WEB_ORIGIN;
  });
  afterEach(() => {
    if (saved.base === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = saved.base;
    if (saved.origin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = saved.origin;
  });

  it("prefers the www origin over a bare-apex first entry (the bug)", () => {
    process.env.WEB_ORIGIN = "https://zaviagent.com,https://www.zaviagent.com";
    expect(resolveAuthRedirectBase()).toBe("https://www.zaviagent.com");
  });

  it("uses the www origin regardless of list order", () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com,https://zaviagent.com";
    expect(resolveAuthRedirectBase()).toBe("https://www.zaviagent.com");
  });

  it("WEB_BASE_URL takes precedence and strips a trailing slash", () => {
    process.env.WEB_BASE_URL = "https://www.zaviagent.com/";
    process.env.WEB_ORIGIN = "https://zaviagent.com";
    expect(resolveAuthRedirectBase()).toBe("https://www.zaviagent.com");
  });

  it("reads a bare-host WEB_BASE_URL as https, so auth links carry a scheme", () => {
    process.env.WEB_BASE_URL = "www.zaviagent.com";
    expect(resolveAuthRedirectBase()).toBe("https://www.zaviagent.com");
  });

  it("keeps an explicit http scheme as written (local dev)", () => {
    process.env.WEB_ORIGIN = "http://localhost:3000";
    expect(resolveAuthRedirectBase()).toBe("http://localhost:3000");
  });

  it("falls back to the first https origin when no www entry exists", () => {
    process.env.WEB_ORIGIN = "https://zaviagent.com,http://localhost:3000";
    expect(resolveAuthRedirectBase()).toBe("https://zaviagent.com");
  });

  it("local dev (no https) returns the first origin unchanged", () => {
    process.env.WEB_ORIGIN = "http://localhost:3000,http://localhost:3002";
    expect(resolveAuthRedirectBase()).toBe("http://localhost:3000");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveAuthRedirectBase()).toBeUndefined();
  });
});
