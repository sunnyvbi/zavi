import { describe, it, expect } from "vitest";
import {
  capRecentRunOutput,
  recentRunCapForIndex,
  RECENT_RUN_OUTPUT_CAP,
  RECENT_RUN_FULL_BODY_COUNT,
  RECENT_RUN_TAIL_CAP,
} from "../generic-dispatcher";

describe("capRecentRunOutput — sibling run-output projection cap", () => {
  it("does NOT truncate a 5000-char sibling output (was cut at 800)", () => {
    const out = capRecentRunOutput("x".repeat(5000));
    expect(out).toBe("x".repeat(5000));
    expect(out).not.toContain("truncated");
  });

  it("cap is 8000 (raised from 800)", () => {
    expect(RECENT_RUN_OUTPUT_CAP).toBe(8000);
  });

  it("still truncates outputs beyond the cap with a marker", () => {
    const out = capRecentRunOutput("y".repeat(9000));
    expect(out).toContain("…[truncated 1000 chars]");
    expect(out.startsWith("y".repeat(8000))).toBe(true);
  });
});

describe("recentRunCapForIndex — graduated recent_runs cap (prompt-budget pass)", () => {
  it("the most-recent N runs keep the FULL body (continuation/consume case)", () => {
    for (let i = 0; i < RECENT_RUN_FULL_BODY_COUNT; i++) {
      expect(recentRunCapForIndex(i)).toBe(RECENT_RUN_OUTPUT_CAP);
    }
  });

  it("older runs get the head-only tail cap (kills the ~20K-tok bloat)", () => {
    expect(recentRunCapForIndex(RECENT_RUN_FULL_BODY_COUNT)).toBe(
      RECENT_RUN_TAIL_CAP,
    );
    expect(recentRunCapForIndex(50)).toBe(RECENT_RUN_TAIL_CAP);
  });

  it("a full 8000-char deliverable at index 0 is NOT truncated", () => {
    const deliverable = "z".repeat(8000);
    expect(capRecentRunOutput(deliverable, recentRunCapForIndex(0))).toBe(
      deliverable,
    );
  });

  it("the same deliverable at an OLDER index IS head-capped with a marker", () => {
    const deliverable = "z".repeat(8000);
    const out = capRecentRunOutput(deliverable, recentRunCapForIndex(10));
    expect(out.startsWith("z".repeat(RECENT_RUN_TAIL_CAP))).toBe(true);
    expect(out).toContain(`…[truncated ${8000 - RECENT_RUN_TAIL_CAP} chars]`);
  });

  it("tail cap is meaningfully smaller than the full cap (real size win)", () => {
    expect(RECENT_RUN_TAIL_CAP).toBeLessThan(RECENT_RUN_OUTPUT_CAP / 5);
  });
});
