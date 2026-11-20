import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nearestTab, railTarget, SETTLE_MS } from "./GrowthThreeSteps";

const source = readFileSync(join(__dirname, "GrowthThreeSteps.tsx"), "utf8");

describe("which step a swipe lands on", () => {
  const PHONE_TAB = 358;
  const centres = [0, 1, 2].map((i) => i * PHONE_TAB + PHONE_TAB / 2);

  it("picks the step the rail is actually showing, at each page of a phone swipe", () => {
    for (const [scrollLeft, expected] of [
      [0, 0],
      [PHONE_TAB, 1],
      [PHONE_TAB * 2, 2],
    ] as const) {
      expect(nearestTab(centres, scrollLeft + PHONE_TAB / 2)).toBe(expected);
    }
  });

  it("picks the nearer step when a swipe stops between two", () => {
    expect(nearestTab(centres, PHONE_TAB * 0.9 + PHONE_TAB / 2)).toBe(1);
    expect(nearestTab(centres, PHONE_TAB * 0.4 + PHONE_TAB / 2)).toBe(0);
  });

  it("keeps the earlier step on an exact tie rather than drifting forward", () => {
    expect(nearestTab(centres, PHONE_TAB)).toBe(0);
  });

  it("returns null rather than 0 when there are no tabs to land on", () => {
    expect(nearestTab([], 100)).toBeNull();
  });
});

describe("the rail and the 5s advance do not fight the reader", () => {
  it("makes the tab a swipe landed on the active one", () => {
    const sync = source.slice(source.indexOf('el.addEventListener("scroll"'));
    expect(source).toContain('el.addEventListener("scroll", onScroll, { passive: true })');
    expect(source).toContain("setActive(landed)");
    expect(sync).toContain('el.removeEventListener("scroll", onScroll)');
  });

  it("does not mistake its own auto-advance scroll for a swipe", () => {
    const place = source.slice(source.indexOf("const place = ()"), source.indexOf("const onScroll"));
    expect(place).toContain("programmatic.current = true");
    expect(place).toMatch(/if \(Math\.abs\(left - el\.scrollLeft\) > 1\) \{\s*programmatic\.current = true;/);
    expect(source).toContain("programmatic.current = false");
  });

  it("waits for the rail to stop before deciding, rather than firing per scroll event", () => {
    expect(SETTLE_MS).toBeGreaterThan(0);
    expect(source).toContain("settling.current = window.setTimeout(");
    expect(source).toContain("if (settling.current !== null) window.clearTimeout(settling.current)");
  });
});

describe("where the rail scrolls to centre a tab", () => {
  const TAB = 300;
  const RAIL = 390;
  const WIDTH = TAB * 3;

  it("clamps the first tab to 0, where the rail already is on load", () => {
    expect(railTarget(0, TAB, RAIL, WIDTH)).toBe(0);
  });

  it("clamps the last tab to the furthest reachable scroll", () => {
    expect(railTarget(TAB * 2, TAB, RAIL, WIDTH)).toBe(WIDTH - RAIL);
  });

  it("centres a middle tab", () => {
    expect(railTarget(TAB, TAB, RAIL, WIDTH)).toBe(TAB - (RAIL - TAB) / 2);
  });
});
