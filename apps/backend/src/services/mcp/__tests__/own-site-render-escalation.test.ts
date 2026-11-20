import { describe, it, expect } from "vitest";
import { sameSite } from "@/services/mcp/own-site";

describe("sameSite — what counts as the company's own site", () => {
  it("matches the domain itself, with or without www or a scheme", () => {
    expect(sameSite("https://acme.test/pricing", "acme.test")).toBe(true);
    expect(sameSite("https://www.acme.test/", "acme.test")).toBe(true);
    expect(sameSite("http://acme.test", "https://www.acme.test")).toBe(true);
    expect(sameSite("https://ACME.test/x", "acme.test")).toBe(true);
  });

  it("matches a subdomain of the company's site", () => {
    expect(sameSite("https://blog.acme.test/post", "acme.test")).toBe(true);
    expect(sameSite("https://shop.eu.acme.test/", "acme.test")).toBe(true);
  });

  it("does NOT match another origin that merely mentions the domain", () => {
    expect(sameSite("https://evil.test/?ref=acme.test", "acme.test")).toBe(false);
    expect(sameSite("https://evil.test/acme.test/login", "acme.test")).toBe(false);
    expect(sameSite("https://notacme.test/", "acme.test")).toBe(false);
    expect(sameSite("https://acme.test.evil.test/", "acme.test")).toBe(false);
  });

  it("is false when either side is unusable, so no domain means no escalation", () => {
    expect(sameSite("not a url", "acme.test")).toBe(false);
    expect(sameSite("https://acme.test", "")).toBe(false);
  });
});
