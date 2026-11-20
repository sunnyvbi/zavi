import { describe, it, expect } from "vitest";
import {
  resolveEngine,
  isHostileOrigin,
  isHostileHost,
  HOSTILE_ORIGIN_SUFFIXES,
} from "../engine-policy";

describe("engine-policy.resolveEngine", () => {
  it("routes the base hostile set to anchor", () => {
    expect(resolveEngine("https://instagram.com")).toBe("anchor");
    expect(resolveEngine("https://www.instagram.com/p/x")).toBe("anchor");
    expect(resolveEngine("https://m.tiktok.com/@u")).toBe("anchor");
    expect(resolveEngine("https://www.linkedin.com/feed")).toBe("anchor");
  });

  it("routes internal / staging / unknown origins to sandbox", () => {
    expect(resolveEngine("https://latest.example.com/login")).toBe("sandbox");
    expect(resolveEngine("https://ravi.dev.upcar.ai")).toBe("sandbox");
    expect(resolveEngine(undefined)).toBe("sandbox");
    expect(resolveEngine("not a url")).toBe("sandbox");
    expect(resolveEngine("")).toBe("sandbox");
  });

  it("is dot-anchored — lookalike domains do NOT match", () => {
    expect(resolveEngine("https://notinstagram.com")).toBe("sandbox");
    expect(resolveEngine("https://instagram.com.evil.test")).toBe("sandbox");
    expect(resolveEngine("https://faketiktok.com")).toBe("sandbox");
  });

  it("honors per-tenant hostile-suffix overrides", () => {
    expect(resolveEngine("https://www.facebook.com", ["facebook.com"])).toBe(
      "anchor",
    );
    expect(resolveEngine("https://www.facebook.com")).toBe("sandbox");
  });
});

describe("engine-policy helpers", () => {
  it("isHostileHost is case-insensitive + dot-anchored", () => {
    expect(isHostileHost("INSTAGRAM.COM")).toBe(true);
    expect(isHostileHost("cdn.instagram.com")).toBe(true);
    expect(isHostileHost("evilinstagram.com")).toBe(false);
  });

  it("isHostileOrigin returns false for missing / unparseable input", () => {
    expect(isHostileOrigin(undefined)).toBe(false);
    expect(isHostileOrigin("::::")).toBe(false);
  });

  it("base set is the three named platforms", () => {
    expect([...HOSTILE_ORIGIN_SUFFIXES].sort()).toEqual([
      "instagram.com",
      "linkedin.com",
      "tiktok.com",
    ]);
  });
});
