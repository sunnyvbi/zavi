import { describe, it, expect } from "vitest";
import { evaluateCaps, utcDayStartIso, type CapLimits } from "../caps";
import { hashSecret, safeHashEqual, generateClientSecret, hashIp } from "../store";

const LIMITS: CapLimits = { perIpDay: 5, globalDay: 200 };

describe("evaluateCaps", () => {
  it("allows when both axes are under their limit", () => {
    expect(evaluateCaps({ ip: 0, global: 0 }, LIMITS)).toEqual({ allowed: true });
    expect(evaluateCaps({ ip: 4, global: 199 }, LIMITS)).toEqual({ allowed: true });
  });

  it("denies at the limit (count >= limit blocks the next render)", () => {
    expect(evaluateCaps({ ip: 5, global: 0 }, LIMITS)).toMatchObject({ allowed: false, axis: "ip" });
  });

  it("checks the global ceiling before per-IP", () => {
    expect(evaluateCaps({ ip: 5, global: 200 }, LIMITS)).toMatchObject({ allowed: false, axis: "global" });
  });

  it("treats a limit of 0 as uncapped on that axis", () => {
    const uncapped: CapLimits = { perIpDay: 0, globalDay: 0 };
    expect(evaluateCaps({ ip: 9999, global: 9999 }, uncapped)).toEqual({ allowed: true });
  });

  it("utcDayStartIso is midnight UTC of the given day", () => {
    expect(utcDayStartIso(new Date("2026-07-02T18:30:00Z"))).toBe("2026-07-02T00:00:00.000Z");
  });
});

describe("store hashing helpers", () => {
  it("hashSecret is deterministic + hex", () => {
    const raw = "abc123";
    expect(hashSecret(raw)).toBe(hashSecret(raw));
    expect(hashSecret(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret("other")).not.toBe(hashSecret(raw));
  });

  it("safeHashEqual matches equal hashes and rejects mismatches/lengths", () => {
    const h = hashSecret("x");
    expect(safeHashEqual(h, h)).toBe(true);
    expect(safeHashEqual(h, hashSecret("y"))).toBe(false);
    expect(safeHashEqual(h, "short")).toBe(false);
  });

  it("generateClientSecret is 64 hex chars; hashIp is 32 hex chars", () => {
    expect(generateClientSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{32}$/);
  });
});
