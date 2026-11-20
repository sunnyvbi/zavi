// @vitest-environment jsdom

import { describe, it, expect } from "vitest";

import { makeClamp } from "@/hooks/useResizablePane";
import { HOME_CHAT_PANE_OPTIONS } from "./CalmHome";

function CURRENT_clampChatWidth(px: number, viewport: number): number {
  const max = Math.max(340, Math.round(viewport * 0.4));
  return Math.min(max, Math.max(340, px));
}

function CURRENT_mount(rawStored: string | null, viewport: number): number {
  const saved = Number(rawStored);
  return CURRENT_clampChatWidth(
    Number.isFinite(saved) && saved > 0 ? saved : 405,
    viewport,
  );
}

function CURRENT_onWindowResize(current: number, viewport: number): number {
  return CURRENT_clampChatWidth(current, viewport);
}

function CURRENT_drag(clientX: number, viewport: number): number {
  return CURRENT_clampChatWidth(viewport - clientX, viewport);
}

function CURRENT_reset(viewport: number): number {
  return CURRENT_clampChatWidth(405, viewport);
}

const clamp = makeClamp(HOME_CHAT_PANE_OPTIONS);

const { defaultPx, resetTo, storageKey } = HOME_CHAT_PANE_OPTIONS;

function MIGRATED_mount(rawStored: string | null, viewport: number): number {
  const saved = Number(rawStored);
  const hasSaved = Number.isFinite(saved) && saved > 0;
  if (defaultPx === undefined) throw new Error("defaultPx must be configured");
  return clamp(hasSaved ? saved : defaultPx, viewport);
}

function MIGRATED_reset(viewport: number): number {
  if (typeof resetTo !== "number") throw new Error("resetTo must be a number");
  return clamp(resetTo, viewport);
}

const INTEGER_VIEWPORTS = [100, 320, 470, 640, 850, 900, 1000, 1024, 1280, 1440, 1920, 2560, 3840];
const FRACTIONAL_VIEWPORTS = [470.6, 999.9, 1023.5, 1237.3, 1440.5, 2001.7, 2560.25];
const ALL_VIEWPORTS = [...INTEGER_VIEWPORTS, ...FRACTIONAL_VIEWPORTS];
const INPUTS = [
  -1000, -1, 0, 1, 100, 339, 339.5, 340, 340.4, 341, 380, 380.5, 399.96, 405,
  409.4, 420, 500, 576, 700, 900, 1200, 1600, 2400, 5000, 100000,
];

describe("CalmHome chat column — equivalence with the pre-migration logic", () => {
  it("the shared clamp matches clampChatWidth for every (input, viewport) pair", () => {
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const got = clamp(px, vw);
        const want = CURRENT_clampChatWidth(px, vw);
        if (!Object.is(got, want)) {
          mismatches.push(`px=${px} vw=${vw}: got ${got}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("rounds the CAP, not the result — the opposite of BrainstormPanel", () => {
    const ROUND_THE_RESULT = (px: number, vw: number) =>
      Math.round(Math.min(Math.max(340, vw * 0.4), Math.max(340, px)));

    const divergences: string[] = [];
    for (const vw of [1440, 1920, 2560, 1440.5, 2001.7]) {
      for (const px of [380.5, 409.4, 500.5, 700.25]) {
        if (!Object.is(ROUND_THE_RESULT(px, vw), CURRENT_clampChatWidth(px, vw))) {
          divergences.push(`px=${px} vw=${vw}`);
        }
      }
    }
    expect(divergences.length).toBeGreaterThan(0);
    for (const vw of [1440, 1920, 2560, 1440.5, 2001.7]) {
      for (const px of [380.5, 409.4, 500.5, 700.25]) {
        expect(clamp(px, vw)).toBe(CURRENT_clampChatWidth(px, vw));
      }
    }
  });

  it("never returns below the 340px floor, on any viewport", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        expect(clamp(px, vw)).toBeGreaterThanOrEqual(340);
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

  it("mount reproduces the old rehydrate for stored, absent, and junk values", () => {
    const STORED = [
      null, "", "0", "-1", "abc", "NaN", "Infinity", "340", "380", "405",
      "380.5", "1200", "99999", " 420 ",
    ];
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const raw of STORED) {
        const got = MIGRATED_mount(raw, vw);
        const want = CURRENT_mount(raw, vw);
        if (!Object.is(got, want)) {
          mismatches.push(`stored=${JSON.stringify(raw)} vw=${vw}: got ${got}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("falls back to the 405px default when nothing is stored", () => {
    expect(MIGRATED_mount(null, 1440)).toBe(405);
    expect(CURRENT_mount(null, 1440)).toBe(405);
  });

  it("a persisted width survives the round-trip EXACTLY — the 380px promise", () => {
    for (const vw of [1280, 1440, 1920, 2560]) {
      expect(MIGRATED_mount("380", vw)).toBe(380);
    }
    expect(MIGRATED_mount("1200", 1280)).toBe(512);
    expect(MIGRATED_mount("1200", 1280)).toBe(CURRENT_mount("1200", 1280));
  });

  it("the window-resize re-clamp behaves identically", () => {
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const current = CURRENT_clampChatWidth(px, 1920);
        const got = clamp(current, vw);
        const want = CURRENT_onWindowResize(current, vw);
        if (!Object.is(got, want)) mismatches.push(`w=${current} vw=${vw}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("a drag maps cursor position to width identically (right-anchored pane)", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const clientX of [-50, 0, 1, 100, 350, 600, vw / 2, vw - 341, vw - 340, vw, vw + 90]) {
        expect(clamp(vw - clientX, vw)).toBe(CURRENT_drag(clientX, vw));
      }
    }
  });

  it("double-click reset reproduces the old clamp(405)", () => {
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_reset(vw)).toBe(CURRENT_reset(vw));
    }
    expect(MIGRATED_reset(900)).toBe(360);
    expect(MIGRATED_reset(1440)).toBe(405);
  });
});

describe("CalmHome chat column — the options that pin the behavior", () => {
  it("persists under its own key so the home and website columns stay independent", () => {
    expect(storageKey).toBe("zavi.homeChatWidth");
    expect(HOME_CHAT_PANE_OPTIONS.onCommit).toBeUndefined();
  });

  it("keeps the clamp spec exactly as it shipped", () => {
    expect(HOME_CHAT_PANE_OPTIONS.min).toBe(340);
    expect(HOME_CHAT_PANE_OPTIONS.maxFraction).toBe(0.4);
    expect(HOME_CHAT_PANE_OPTIONS.round).toBe("max");
    expect(HOME_CHAT_PANE_OPTIONS.maxPx).toBeUndefined();
    expect(HOME_CHAT_PANE_OPTIONS.maxFn).toBeUndefined();
  });

  it("renders 405 before mount and defaults to 405 after", () => {
    expect(defaultPx).toBe(405);
    expect(HOME_CHAT_PANE_OPTIONS.defaultFn).toBeUndefined();
    expect(HOME_CHAT_PANE_OPTIONS.initialSizePx ?? defaultPx).toBe(405);
  });

  it("rehydrates, re-clamps on resize, and paints the body cursor", () => {
    expect(HOME_CHAT_PANE_OPTIONS.rehydrate ?? !!storageKey).toBe(true);
    expect(HOME_CHAT_PANE_OPTIONS.reclampOnResize ?? true).toBe(true);
    expect(HOME_CHAT_PANE_OPTIONS.setBodyCursor ?? true).toBe(true);
  });

  it("tracks drag state in REACT STATE, not a ref", () => {
    expect(HOME_CHAT_PANE_OPTIONS.trackDragging).toBe(true);
  });

  it("binds listeners per-drag, resets on double-click, and keeps the label", () => {
    expect(HOME_CHAT_PANE_OPTIONS.permanentListeners ?? false).toBe(false);
    expect(resetTo).toBe(405);
    expect(HOME_CHAT_PANE_OPTIONS.resetOnDoubleClick ?? resetTo !== undefined).toBe(true);
    expect(HOME_CHAT_PANE_OPTIONS.ariaLabel).toBe("Resize chat");
    expect(HOME_CHAT_PANE_OPTIONS.keyboard ?? false).toBe(false);
  });
});
