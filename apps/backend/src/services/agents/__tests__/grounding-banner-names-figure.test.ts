import { describe, it, expect } from "vitest";
import { namedQuantToken, buildHardFlagBanner } from "../autonomous-grounding";
import type { GroundingFlag } from "../eval/grounding-checks";

const quantFlag = (detail: string): GroundingFlag => ({
  pattern: "unsupported_quant_claim",
  severity: "hard",
  detail,
});

describe("BUG 9 — the banner points at the specific claim", () => {
  it("extracts the offending figure from a real C8 detail string", () => {
    const detail =
      'asserts "$30" as live business/DB state but no successful tool result this run returned that figure and it is not in the fed-in context';
    expect(namedQuantToken({ flags: [quantFlag(detail)], hint: "review" })).toBe("$30");
  });

  it("returns null rather than guessing when the detail has no quoted token", () => {
    expect(
      namedQuantToken({ flags: [quantFlag("asserts a figure with no quoted token")], hint: "review" }),
    ).toBeNull();
  });

  it("ignores flags of other patterns", () => {
    expect(
      namedQuantToken({
        flags: [{ pattern: "line_cite_not_read", severity: "hard", detail: 'asserts "foo.ts:1"' }],
        hint: "review",
      }),
    ).toBeNull();
  });

  it("the non-chat banner names the figure (regression pin for the 2026-07-15 fix)", () => {
    const banner = buildHardFlagBanner({
      flags: [quantFlag('asserts "$1,492" as live business/DB state but no successful tool result')],
      hint: "review",
    });
    expect(banner).toContain("$1,492");
  });

  it("never leaks the internal pattern id or the mechanical detail to the customer", () => {
    const banner = buildHardFlagBanner({
      flags: [quantFlag('asserts "$30" as live business/DB state but no successful tool result this run returned that figure')],
      hint: "review",
    });
    expect(banner).not.toContain("unsupported_quant_claim");
    expect(banner).not.toContain("no successful tool result");
    expect(banner).toContain("$30");
  });
});
