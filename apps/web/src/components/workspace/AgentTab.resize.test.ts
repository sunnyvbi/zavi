
import { describe, it, expect } from "vitest";

import { makeClamp } from "@/hooks/useResizablePane";
import { AGENT_CHAT_PANE_OPTIONS, chatPaneLayout } from "./AgentTab";

function CURRENT_clampChatWidth(px: number, viewport: number): number {
  const max = Math.max(340, Math.round(viewport * 0.4));
  return Math.min(max, Math.max(340, px));
}

function CURRENT_hydrate(rawStored: string | null, viewport: number): number {
  const saved = Number(rawStored);
  return CURRENT_clampChatWidth(
    Number.isFinite(saved) && saved > 0 ? saved : 420,
    viewport,
  );
}

function CURRENT_reclamp(current: number, viewport: number): number {
  return CURRENT_clampChatWidth(current, viewport);
}

function CURRENT_drag(clientX: number, viewport: number): number {
  return CURRENT_clampChatWidth(viewport - clientX, viewport);
}

function CURRENT_reset(viewport: number): number {
  return CURRENT_clampChatWidth(420, viewport);
}

const clamp = makeClamp(AGENT_CHAT_PANE_OPTIONS);
const { defaultPx, resetTo, storageKey } = AGENT_CHAT_PANE_OPTIONS;

function MIGRATED_hydrate(rawStored: string | null, viewport: number): number {
  if (typeof defaultPx !== "number") throw new Error("defaultPx must be a number");
  const saved = Number(rawStored);
  const hasSaved = Number.isFinite(saved) && saved > 0;
  return clamp(hasSaved ? saved : defaultPx, viewport);
}

function MIGRATED_reset(viewport: number): number {
  if (typeof resetTo !== "number") throw new Error("resetTo must be a number");
  return clamp(resetTo, viewport);
}

const INTEGER_VIEWPORTS = [
  100, 320, 640, 849, 850, 851, 1024, 1280, 1440, 1920, 2560, 3840,
];
const FRACTIONAL_VIEWPORTS = [
  849.5, 999.9, 1023.5, 1237.3, 1440.5, 2001.7, 2560.25,
];
const ALL_VIEWPORTS = [...INTEGER_VIEWPORTS, ...FRACTIONAL_VIEWPORTS];
const INPUTS = [
  -1000, -1, 0, 1, 100, 339, 339.5, 340, 340.4, 341, 400, 409.4, 419, 420,
  420.5, 421, 494.92, 500, 576, 700, 900, 1200, 1536, 2400, 5000, 100000,
];

describe("AgentTab chat column resize — equivalence with the pre-migration logic", () => {
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

  it("rounds the CAP, not the result — and the difference is inside the swept range", () => {
    const ROUND_THE_RESULT = (px: number, vw: number) =>
      Math.round(Math.min(Math.max(340, vw * 0.4), Math.max(340, px)));

    const divergences: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        if (!Object.is(ROUND_THE_RESULT(px, vw), CURRENT_clampChatWidth(px, vw))) {
          divergences.push(`px=${px} vw=${vw}`);
        }
      }
    }
    expect(divergences.length).toBeGreaterThan(0);
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        expect(clamp(px, vw)).toBe(CURRENT_clampChatWidth(px, vw));
      }
    }
  });

  it("a wrong floor or a wrong fraction would be caught by the sweep", () => {
    const WRONG_FLOOR = makeClamp({ min: 400, maxFraction: 0.4, round: "max" });
    const WRONG_FRACTION = makeClamp({ min: 340, maxFraction: 0.45, round: "max" });
    const floorDiffs = ALL_VIEWPORTS.flatMap((vw) =>
      INPUTS.filter((px) => WRONG_FLOOR(px, vw) !== CURRENT_clampChatWidth(px, vw)),
    );
    const fracDiffs = ALL_VIEWPORTS.flatMap((vw) =>
      INPUTS.filter((px) => WRONG_FRACTION(px, vw) !== CURRENT_clampChatWidth(px, vw)),
    );
    expect(floorDiffs.length).toBeGreaterThan(0);
    expect(fracDiffs.length).toBeGreaterThan(0);
  });

  it("always returns an integer-or-input at or above the 340px floor", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        expect(clamp(px, vw)).toBeGreaterThanOrEqual(340);
      }
    }
  });

  it("is idempotent, so the hook's extra clamp on reset/re-clamp is a no-op", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const px of INPUTS) {
        const once = clamp(px, vw);
        expect(clamp(once, vw)).toBe(once);
      }
    }
  });

  it("rehydrates a stored width identically, including junk stored values", () => {
    const STORED = [
      null, "", "0", "-5", "abc", "NaN", "340", "420", "900", "900.5",
      "1600", "99999", "Infinity",
    ];
    const mismatches: string[] = [];
    for (const vw of ALL_VIEWPORTS) {
      for (const raw of STORED) {
        const got = MIGRATED_hydrate(raw, vw);
        const want = CURRENT_hydrate(raw, vw);
        if (!Object.is(got, want)) {
          mismatches.push(`stored=${JSON.stringify(raw)} vw=${vw}: got ${got}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("THE PROMISE: a user who dragged to 900px still sees exactly 900px", () => {
    expect(MIGRATED_hydrate("900", 2560)).toBe(900);
    expect(CURRENT_hydrate("900", 2560)).toBe(900);
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_hydrate("900", vw)).toBe(CURRENT_hydrate("900", vw));
    }
  });

  it("uses the same localStorage key, so existing widths are found at all", () => {
    expect(storageKey).toBe("zavi.agentChatWidth");
  });

  it("defaults to 420 and re-clamps on window resize identically", () => {
    expect(defaultPx).toBe(420);
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_hydrate(null, vw)).toBe(CURRENT_hydrate(null, vw));
      for (const px of INPUTS) {
        const current = CURRENT_clampChatWidth(px, 1920);
        expect(clamp(current, vw)).toBe(CURRENT_reclamp(current, vw));
      }
    }
  });

  it("double-click reset reproduces the old clampChatWidth(420, vw)", () => {
    for (const vw of ALL_VIEWPORTS) {
      expect(MIGRATED_reset(vw)).toBe(CURRENT_reset(vw));
    }
    expect(MIGRATED_reset(800)).toBe(340);
    expect(MIGRATED_reset(1920)).toBe(420);
  });

  it("a drag maps cursor position to width identically (right-anchored column)", () => {
    for (const vw of ALL_VIEWPORTS) {
      for (const clientX of [
        -50, 0, 1, 100, 350, 600, vw / 2, vw - 341, vw - 340, vw, vw + 90,
      ]) {
        expect(clamp(vw - clientX, vw)).toBe(CURRENT_drag(clientX, vw));
      }
    }
  });
});

describe("AgentTab chat column resize — the options that must not drift", () => {
  it("keeps this surface's own clamp spec", () => {
    expect(AGENT_CHAT_PANE_OPTIONS.min).toBe(340);
    expect(AGENT_CHAT_PANE_OPTIONS.maxFraction).toBe(0.4);
    expect(AGENT_CHAT_PANE_OPTIONS.round).toBe("max");
  });

  it("persists locally, rehydrates on mount, and re-clamps on resize", () => {
    expect(AGENT_CHAT_PANE_OPTIONS.storageKey).toBe("zavi.agentChatWidth");
    expect(AGENT_CHAT_PANE_OPTIONS.rehydrate ?? true).toBe(true);
    expect(AGENT_CHAT_PANE_OPTIONS.reclampOnResize ?? true).toBe(true);
    expect(AGENT_CHAT_PANE_OPTIONS.onCommit).toBeUndefined();
  });

  it("keeps the body cursor and the `dragging` flag the old code set by hand", () => {
    expect(AGENT_CHAT_PANE_OPTIONS.trackDragging ?? true).toBe(true);
    expect(AGENT_CHAT_PANE_OPTIONS.setBodyCursor ?? true).toBe(true);
    expect(AGENT_CHAT_PANE_OPTIONS.permanentListeners ?? false).toBe(false);
  });

  it("resets to 420 on double-click and keeps the separator's accessible name", () => {
    expect(AGENT_CHAT_PANE_OPTIONS.resetTo).toBe(420);
    expect(AGENT_CHAT_PANE_OPTIONS.resetOnDoubleClick ?? true).toBe(true);
    expect(AGENT_CHAT_PANE_OPTIONS.ariaLabel).toBe("Resize chat");
    expect(AGENT_CHAT_PANE_OPTIONS.keyboard ?? false).toBe(false);
  });
});

describe("chatPaneLayout — collapsed chat + thread pane", () => {
  const VW = 1440;
  const CEILING = Math.round(VW * 0.48);
  const dashboardPx = (chat: number, extra: number) => VW - 224 - chat - extra;

  it("sizes the pane from the viewport, not a fixed px", () => {
    const at1440 = chatPaneLayout(420, true, 27, 1440);
    const at2560 = chatPaneLayout(420, true, 27, 2560);
    expect(at2560.paneExtraPx).toBeGreaterThan(at1440.paneExtraPx);
    expect(at1440.chatVisiblePx + at1440.paneExtraPx).toBeLessThanOrEqual(CEILING);
  });

  it("leaves the dashboard readable at every size", () => {
    for (const vw of [1280, 1440, 1728, 2560]) {
      const { chatVisiblePx, paneExtraPx } = chatPaneLayout(420, true, 27, vw);
      const preview = vw - 224 - chatVisiblePx - paneExtraPx;
      expect(preview).toBeGreaterThan(400);
    }
  });

  it("never lets chat+pane exceed the ceiling, however wide the chat was dragged", () => {
    const wide = Math.round(VW * 0.4);
    const { chatVisiblePx, paneExtraPx } = chatPaneLayout(wide, true, 27, VW);
    expect(chatVisiblePx + paneExtraPx).toBeLessThanOrEqual(CEILING);
    expect(chatVisiblePx + paneExtraPx).toBeLessThan(965);
    expect(dashboardPx(chatVisiblePx, paneExtraPx)).toBeGreaterThanOrEqual(400);
  });

  it("makes the CHAT yield when the ceiling binds — the pane never vanishes", () => {
    const { chatVisiblePx, paneExtraPx } = chatPaneLayout(
      Math.round(VW * 0.4),
      true,
      27,
      VW,
    );
    expect(paneExtraPx).toBeGreaterThan(200);
    expect(chatVisiblePx).toBeGreaterThanOrEqual(340);
  });

  it("is a no-op with no thread open — the persisted width is untouched", () => {
    expect(chatPaneLayout(576, false, 27, VW)).toEqual({
      chatVisiblePx: 576,
      paneExtraPx: 0,
    });
  });

  it("is inert before the viewport is measured (SSR / first paint)", () => {
    expect(chatPaneLayout(420, true, 27, 0)).toEqual({
      chatVisiblePx: 420,
      paneExtraPx: 0,
    });
  });
});

describe("chatPaneLayout — proportional collapsed widths", () => {
  const SIZES = [1280, 1440, 1728, 2560];

  it("scales both columns with the screen", () => {
    const panes = SIZES.map((vw) => chatPaneLayout(420, true, 27, vw).paneExtraPx);
    for (let i = 1; i < panes.length; i++) {
      expect(panes[i]).toBeGreaterThan(panes[i - 1]);
    }
  });

  it("keeps the whole region inside its ceiling at every size", () => {
    for (const vw of SIZES) {
      const { chatVisiblePx, paneExtraPx } = chatPaneLayout(420, true, 27, vw);
      expect(chatVisiblePx + paneExtraPx).toBeLessThanOrEqual(Math.round(vw * 0.48));
    }
  });

  it("never starves the chat below its floor", () => {
    for (const vw of SIZES) {
      expect(chatPaneLayout(420, true, 27, vw).chatVisiblePx).toBeGreaterThanOrEqual(340);
    }
  });

  it("never lets the pane collapse to nothing", () => {
    for (const vw of SIZES) {
      expect(chatPaneLayout(420, true, 27, vw).paneExtraPx).toBeGreaterThan(200);
    }
  });
});
