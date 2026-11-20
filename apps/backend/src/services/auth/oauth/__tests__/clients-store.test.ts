import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri } from "../clients-store";
import { generateToken, OAT_PREFIX, ORT_PREFIX, CODE_PREFIX, PREFIX_LOOKUP_LEN } from "../tokens";

describe("redirect_uri policy (RFC 8252)", () => {
  it("allows https (exact)", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/callback")).toBe(true);
  });
  it("allows loopback http on any port", () => {
    expect(isAllowedRedirectUri("http://localhost:51763/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8976/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:4000/cb")).toBe(true);
  });
  it("rejects non-loopback http", () => {
    expect(isAllowedRedirectUri("http://evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://example.org:80/cb")).toBe(false);
  });
});

describe("token generation", () => {
  it("uses the right prefix and a stable lookup prefix length", () => {
    const a = generateToken(OAT_PREFIX);
    const r = generateToken(ORT_PREFIX);
    const c = generateToken(CODE_PREFIX);
    expect(a.raw.startsWith(OAT_PREFIX)).toBe(true);
    expect(r.raw.startsWith(ORT_PREFIX)).toBe(true);
    expect(c.raw.startsWith(CODE_PREFIX)).toBe(true);
    expect(a.prefix.length).toBe(PREFIX_LOOKUP_LEN);
    expect(a.prefix).toBe(a.raw.slice(0, PREFIX_LOOKUP_LEN));
    expect(a.hash).not.toBe(generateToken(OAT_PREFIX).hash);
  });
});
