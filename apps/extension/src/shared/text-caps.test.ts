import { describe, expect, it } from "vitest";
import { byteLength, truncateToBytes } from "./text-caps";

describe("truncateToBytes", () => {
  it("is a no-op below the cap", () => {
    expect(truncateToBytes("abc", 10)).toBe("abc");
  });

  it("counts BYTES, not characters", () => {
    expect(truncateToBytes("ééé", 3)).toBe("é");
    expect(byteLength(truncateToBytes("ééé", 3))).toBeLessThanOrEqual(3);
  });

  it("never leaves a lone high surrogate", () => {
    const out = truncateToBytes("😀😀", 6);
    expect(byteLength(out)).toBeLessThanOrEqual(6);
    const last = out.charCodeAt(out.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("returns empty for a non-positive budget", () => {
    expect(truncateToBytes("abc", 0)).toBe("");
    expect(truncateToBytes("abc", -1)).toBe("");
  });

  it("cuts a long ascii string to exactly the budget", () => {
    expect(truncateToBytes("x".repeat(100), 10)).toBe("x".repeat(10));
  });
});

describe("byteLength", () => {
  it("measures UTF-8, not UTF-16", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("😀")).toBe(4);
  });
});
