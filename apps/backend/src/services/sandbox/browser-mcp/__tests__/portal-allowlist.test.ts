import { describe, it, expect, vi, beforeEach } from "vitest";

const getSetting = vi.fn();
vi.mock("@/services/settings", () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
}));

import { getPortalAllowlist, isNavOriginAllowed } from "../portal-allowlist";

beforeEach(() => getSetting.mockReset());

describe("getPortalAllowlist", () => {
  it("returns empty set when no tenant_id", async () => {
    expect((await getPortalAllowlist(null)).size).toBe(0);
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("returns empty set on a settings read error (fail-open on the setting)", async () => {
    getSetting.mockRejectedValueOnce(new Error("db down"));
    expect((await getPortalAllowlist("t1")).size).toBe(0);
  });

  it("normalizes entries to origins and drops malformed ones", async () => {
    getSetting.mockResolvedValueOnce([
      "https://app.vendor.com/dashboard?x=1",
      "  https://portal.two.com  ",
      "not a url",
      42,
    ]);
    const set = await getPortalAllowlist("t1");
    expect([...set].sort()).toEqual([
      "https://app.vendor.com",
      "https://portal.two.com",
    ]);
  });

  it("returns empty set when the value is not an array", async () => {
    getSetting.mockResolvedValueOnce("https://x.com");
    expect((await getPortalAllowlist("t1")).size).toBe(0);
  });
});

describe("isNavOriginAllowed", () => {
  it("allows everything when the allowlist is empty (no restriction)", async () => {
    getSetting.mockResolvedValueOnce([]);
    const r = await isNavOriginAllowed("t1", "https://anything.com/x");
    expect(r).toMatchObject({ allowed: true, hadAllowlist: false });
  });

  it("allows an origin that is on a non-empty allowlist", async () => {
    getSetting.mockResolvedValueOnce(["https://app.vendor.com"]);
    const r = await isNavOriginAllowed("t1", "https://app.vendor.com/deep/path");
    expect(r).toMatchObject({ allowed: true, hadAllowlist: true });
  });

  it("refuses an origin not on a non-empty allowlist", async () => {
    getSetting.mockResolvedValueOnce(["https://app.vendor.com"]);
    const r = await isNavOriginAllowed("t1", "https://evil.com/phish");
    expect(r).toMatchObject({ allowed: false, hadAllowlist: true, origin: "https://evil.com" });
  });

  it("refuses a lookalike host (no substring/suffix bypass)", async () => {
    getSetting.mockResolvedValueOnce(["https://app.vendor.com"]);
    const r = await isNavOriginAllowed("t1", "https://app.vendor.com.evil.tld/x");
    expect(r.allowed).toBe(false);
  });

  it("refuses an unparseable URL against a non-empty allowlist (fail-closed match)", async () => {
    getSetting.mockResolvedValueOnce(["https://app.vendor.com"]);
    const r = await isNavOriginAllowed("t1", "::::not a url");
    expect(r).toMatchObject({ allowed: false, hadAllowlist: true });
  });
});
