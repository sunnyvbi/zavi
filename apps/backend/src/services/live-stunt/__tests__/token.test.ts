import { describe, it, expect } from "vitest";
import { newReviewToken, hashToken, tokenValid } from "../token";

describe("review token", () => {
  it("mints 43-char base64url tokens that differ", () => {
    const a = newReviewToken(), b = newReviewToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it("hashes deterministically to sha256 hex", () => {
    expect(hashToken("x")).toBe(hashToken("x"));
    expect(hashToken("x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("validates hash, expiry and consumption", () => {
    const t = newReviewToken(), h = hashToken(t), now = new Date("2026-10-02T00:00:00Z");
    expect(tokenValid({ presented: t, storedHash: h, expiresAt: "2026-10-03T00:00:00Z", now })).toBe(true);
    expect(tokenValid({ presented: "nope", storedHash: h, expiresAt: "2026-10-03T00:00:00Z", now })).toBe(false);
    expect(tokenValid({ presented: t, storedHash: h, expiresAt: "2026-10-01T00:00:00Z", now })).toBe(false);
    expect(tokenValid({ presented: t, storedHash: null, expiresAt: "2026-10-03T00:00:00Z", now })).toBe(false);
  });
});
