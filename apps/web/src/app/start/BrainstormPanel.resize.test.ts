// @vitest-environment jsdom

import { describe, it, expect } from "vitest";

import { makeClamp } from "@/hooks/useResizablePane";
import { BRAINSTORM_PANE_OPTIONS } from "./BrainstormPanel";

function CURRENT_clampW(px: number, viewport: number): number {
  return Math.round(Math.max(400, Math.min(px, viewport * 0.85)));
}

function CURRENT_default(viewport: number): number {
  return CURRENT_clampW(viewport * 0.4, viewport);
}

function CURRENT_toggleWide(w: number | null, viewport: number): number {
  const narrow = CURRENT_clampW(viewport * 0.4, viewport);
  const wide = CURRENT_clampW(viewport * 0.7, viewport);
  return w !== null && w >= (narrow + wide) / 2 ? narrow : wide;
}

function CURRENT_drag(clientX: number, viewport: number): number {
  return CURRENT_clampW(viewport - clientX, viewport);
}

const clamp = makeClamp(BRAINSTORM_PANE_OPTIONS);

const { resetTo, defaultFn } = BRAINSTORM_PANE_OPTIONS;

function MIGRATED_toggleWide(w: number | null, viewport: number): number {
  if (typeof resetTo !== "function") throw new Error("resetTo must be a function");
  return clamp(resetTo(w, viewport), viewport);
}

function MIGRATED_default(viewport: number): number {
  if (!defaultFn) throw new Error("defaultFn must be configured");
  return clamp(defaultFn(viewport), viewport);
}

const INTEGER_VIEWPORTS = [100, 320, 470, 640, 900, 1000, 1024, 1280, 1440, 1920, 2560, 3840];
const FRACTIONAL_VIEWPORTS = [470.6, 999.9, 1023.5, 1237.3, 1440.5, 2001.7, 2560.25];
const ALL_VIEWPORTS = [...INTEGER_VIEWPORTS, ...FRACTIONAL_VIEWPORTS];
const INPUTS = [
  -1000, -1, 0, 1, 100, 340, 399, 399.5, 400, 400.4, 401, 405, 409.4, 420, 500,
  700, 849.915, 869.975, 900, 1200, 1600, 2400, 5000, 100000,
];

describe("BrainstormPanel resize — equivalence with the pre-migration logic", () => {
  it("the shared clamp matches clampW for every (input, viewport) pair", () => {
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const got = clamp(px, vw);
        const want = CURRENT_clampW(px, vw);
        if (!Object.is(got, want)) {
          mismatches.push(`px=${px} vw=${vw}: got ${got}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("rounds the RESULT, not the cap — the difference is visible on fractional viewports", () => {
    const ROUND_THE_CAP = (px: number, vw: number) =>
      Math.min(Math.max(400, Math.round(vw * 0.85)), Math.max(400, px));

    const divergences: string[] = [];
    for (const vw of FRACTIONAL_VIEWPORTS) {
      for (const px of [400.4, 409.4, 500.5, 700.25, 849.915, 869.975]) {
        if (!Object.is(ROUND_THE_CAP(px, vw), CURRENT_clampW(px, vw))) {
          divergences.push(`px=${px} vw=${vw}`);
        }
      }
    }
    expect(divergences.length).toBeGreaterThan(0);
    for (const vw of FRACTIONAL_VIEWPORTS) {
      for (const px of [400.4, 409.4, 500.5, 700.25, 849.915, 869.975]) {
        expect(clamp(px, vw)).toBe(CURRENT_clampW(px, vw));
      }
    }
  });

  it("always returns an integer at or above the 400px floor", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const got = clamp(px, vw);
        expect(Number.isInteger(got)).toBe(true);
        expect(got).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("is idempotent, so the hook's extra reset-time clamp is a no-op", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const once = clamp(px, vw);
        expect(clamp(once, vw)).toBe(once);
      }
    }
  });

  it("the default is the 40% figure passed THROUGH the clamp, not raw vw*0.4", () => {
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_default(vw)).toBe(CURRENT_default(vw));
    }
  });

  it("floors at 400 on viewports under 1000px rather than going narrower", () => {
    expect(950 * 0.4).toBeLessThan(400);
    expect(MIGRATED_default(950)).toBe(400);
    expect(MIGRATED_default(320)).toBe(400);
    expect(MIGRATED_default(1440)).toBe(576);
  });

  it("toggleWide reproduces the old 40%↔70% flip from every starting width", () => {
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      const starts: (number | null)[] = [
        null,
        ...INPUTS.map((px) => CURRENT_clampW(px, vw)),
      ];
      for (const w of starts) {
        const got = MIGRATED_toggleWide(w, vw);
        const want = CURRENT_toggleWide(w, vw);
        if (!Object.is(got, want)) {
          mismatches.push(`w=${w} vw=${vw}: got ${got}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("toggleWide from the pre-mount null width opens WIDE, as it always has", () => {
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_toggleWide(null, vw)).toBe(CURRENT_clampW(vw * 0.7, vw));
    }
  });

  it("toggleWide round-trips narrow → wide → narrow", () => {
    for (const vw of INTEGER_VIEWPORTS) {
      const narrow = CURRENT_clampW(vw * 0.4, vw);
      const wide = MIGRATED_toggleWide(narrow, vw);
      if (narrow === CURRENT_clampW(vw * 0.7, vw)) {
        expect(wide).toBe(narrow);
        continue;
      }
      expect(wide).toBeGreaterThan(narrow);
      expect(MIGRATED_toggleWide(wide, vw)).toBe(narrow);
    }
  });

  it("a drag maps cursor position to width identically (right-anchored pane)", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const clientX of [-50, 0, 1, 100, 350, 600, vw / 2, vw - 401, vw - 400, vw, vw + 90]) {
        expect(clamp(vw - clientX, vw)).toBe(CURRENT_drag(clientX, vw));
      }
    }
  });
});

describe("BrainstormPanel resize — the options that make it different on purpose", () => {
  it("does not persist: no storageKey and no rehydrate", () => {
    expect(BRAINSTORM_PANE_OPTIONS.storageKey).toBeUndefined();
    expect(BRAINSTORM_PANE_OPTIONS.rehydrate).toBe(false);
    expect(BRAINSTORM_PANE_OPTIONS.onCommit).toBeUndefined();
  });

  it("renders no width before mount: initialSizePx is explicitly null", () => {
    expect(BRAINSTORM_PANE_OPTIONS.initialSizePx).toBeNull();
    expect(BRAINSTORM_PANE_OPTIONS.defaultPx).toBeUndefined();
    expect(typeof BRAINSTORM_PANE_OPTIONS.defaultFn).toBe("function");
    expect(BRAINSTORM_PANE_OPTIONS.rehydrate).toBe(false);
  });

  it("keeps the deliberate divergences from the three chat columns", () => {
    expect(BRAINSTORM_PANE_OPTIONS.min).toBe(400);
    expect(BRAINSTORM_PANE_OPTIONS.maxFraction).toBe(0.85);
    expect(BRAINSTORM_PANE_OPTIONS.round).toBe("result");
    expect(BRAINSTORM_PANE_OPTIONS.reclampOnResize).toBe(false);
    expect(BRAINSTORM_PANE_OPTIONS.setBodyCursor).toBe(false);
    expect(BRAINSTORM_PANE_OPTIONS.trackDragging).toBe(false);
    expect(BRAINSTORM_PANE_OPTIONS.permanentListeners).toBe(true);
    expect(BRAINSTORM_PANE_OPTIONS.resetOnDoubleClick).toBe(false);
    expect(typeof BRAINSTORM_PANE_OPTIONS.resetTo).toBe("function");
    expect(BRAINSTORM_PANE_OPTIONS.ariaLabel).toBe("Drag to resize");
    expect(BRAINSTORM_PANE_OPTIONS.keyboard ?? false).toBe(false);
  });
});
