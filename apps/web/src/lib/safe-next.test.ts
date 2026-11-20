import { describe, it, expect } from "vitest";
import { oauthConsentNext, safeNext } from "./safe-next";

describe("safeNext", () => {
  it("accepts a same-origin path", () => {
    expect(safeNext("/extension/connect", "/workspace")).toBe("/extension/connect");
    expect(safeNext("/workspace?tab=growth", "/start")).toBe("/workspace?tab=growth");
  });

  it("refuses an absolute URL", () => {
    expect(safeNext("https://evil.com", "/workspace")).toBe("/workspace");
    expect(safeNext("http://evil.com/x", "/start")).toBe("/start");
    expect(safeNext("javascript:alert(1)", "/workspace")).toBe("/workspace");
  });

  it("refuses a protocol-relative URL", () => {
    expect(safeNext("//evil.com", "/workspace")).toBe("/workspace");
    expect(safeNext("//evil.com/path", "/workspace")).toBe("/workspace");
  });

  it("refuses a backslash authority, because the URL parser treats it as a slash", () => {
    expect(new URL("/\\evil.com", "https://www.zaviagent.com").origin).toBe(
      "https://evil.com",
    );
    expect(safeNext("/\\evil.com", "/workspace")).toBe("/workspace");
  });

  it("falls back on empty, null and undefined", () => {
    expect(safeNext("", "/workspace")).toBe("/workspace");
    expect(safeNext(null, "/workspace")).toBe("/workspace");
    expect(safeNext(undefined, "/workspace")).toBe("/workspace");
  });

  it("refuses a relative path with no leading slash", () => {
    expect(safeNext("evil.com", "/workspace")).toBe("/workspace");
    expect(safeNext("../../etc", "/workspace")).toBe("/workspace");
  });

  it("refuses control characters, because the URL parser strips them", () => {
    for (const raw of ["/\t/evil.com", "/\n/evil.com", "/\r\\evil.com"]) {
      expect(new URL(raw, "https://www.zaviagent.com").origin).toBe("https://evil.com");
      expect(safeNext(raw, "/workspace")).toBe("/workspace");
    }
  });
});

describe("oauthConsentNext", () => {
  it("keeps the consent page with its signed request", () => {
    expect(oauthConsentNext("/oauth/consent?req=a.b.c")).toBe("/oauth/consent?req=a.b.c");
  });

  it("keeps the Shopify install landing page with its token", () => {
    expect(oauthConsentNext("/connectors/shopify/install?token=a.b")).toBe("/connectors/shopify/install?token=a.b");
  });

  it("refuses every other path", () => {
    for (const raw of ["/workspace", "/oauth/consentx?req=a", "/oauth/consent/x?req=a", "/oauth", "/login?next=/oauth/consent", "/connectors/shopify", "/connectors/shopify/install/x"]) {
      expect(oauthConsentNext(raw)).toBeNull();
    }
  });

  it("refuses an unsafe or encoded path that only looks like the consent page", () => {
    for (const raw of ["https://evil.com/oauth/consent?req=a", "//evil.com/oauth/consent", "/oauth/./consent?req=a", "/oauth/%63onsent?req=a", "/\evil.com/oauth/consent"]) {
      expect(oauthConsentNext(raw)).toBeNull();
    }
  });

  it("is null when there is no next", () => {
    expect(oauthConsentNext(null)).toBeNull();
    expect(oauthConsentNext(undefined)).toBeNull();
    expect(oauthConsentNext("")).toBeNull();
  });
});
