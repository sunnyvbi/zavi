
import { describe, it, expect } from "vitest";
import {
  couldClamp,
  COLLAPSE_MIN_TEXT_LEN,
  COLLAPSE_MIN_LINES,
} from "./CollapsibleMarkdown";

const repeat = (s: string, n: number) => new Array(n + 1).join(s);

describe("couldClamp pre-gate", () => {
  it("short single-line replies are never candidates for clamping", () => {
    expect(couldClamp("")).toBe(false);
    expect(couldClamp("Yes — two campaigns are dead. Want the list?")).toBe(
      false,
    );
    expect(couldClamp(repeat("x", COLLAPSE_MIN_TEXT_LEN - 1))).toBe(false);
  });

  it("long replies become measurement candidates (by char count)", () => {
    expect(couldClamp(repeat("x", COLLAPSE_MIN_TEXT_LEN))).toBe(true);
    expect(couldClamp(repeat("x", 5004))).toBe(true);
  });

  it("short-but-TALL replies become candidates (by line count)", () => {
    const denseTable = repeat("| a | b |\n", COLLAPSE_MIN_LINES + 2);
    expect(denseTable.length).toBeLessThan(COLLAPSE_MIN_TEXT_LEN);
    expect(couldClamp(denseTable)).toBe(true);
  });

  it("a few-line short reply still skips measurement", () => {
    expect(couldClamp("Line one.\nLine two.\nLine three.")).toBe(false);
  });

  it("thresholds stay conservative (a normal answer is under them)", () => {
    expect(COLLAPSE_MIN_TEXT_LEN).toBeGreaterThanOrEqual(400);
    expect(COLLAPSE_MIN_TEXT_LEN).toBeLessThanOrEqual(900);
    expect(COLLAPSE_MIN_LINES).toBeGreaterThanOrEqual(10);
  });
});
