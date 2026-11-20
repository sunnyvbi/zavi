// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { makeClamp, useResizablePane, type UseResizablePaneOptions } from "./useResizablePane";

const CHAT_MIN_PX = 340;
const CHAT_MAX_FRACTION = 0.4;
function CURRENT_clampChatWidth(px: number, viewport: number): number {
  const max = Math.max(CHAT_MIN_PX, Math.round(viewport * CHAT_MAX_FRACTION));
  return Math.min(max, Math.max(CHAT_MIN_PX, px));
}

function CURRENT_clampW(px: number, viewport: number): number {
  return Math.round(Math.max(400, Math.min(px, viewport * 0.85)));
}

type SurfaceConfig = {
  name: string;
  options: UseResizablePaneOptions;
  current: (px: number, viewport: number) => number;
  storageKey: string | undefined;
  currentDefault: (viewport: number) => number;
};

const AGENT_TAB: SurfaceConfig = {
  name: "AgentTab",
  options: {
    storageKey: "zavi.agentChatWidth",
    min: 340,
    maxFraction: 0.4,
    round: "max",
    defaultPx: 420,
    resetTo: 420,
  },
  current: CURRENT_clampChatWidth,
  storageKey: "zavi.agentChatWidth",
  currentDefault: (vw) => CURRENT_clampChatWidth(420, vw),
};

const CALM_HOME: SurfaceConfig = {
  name: "CalmHome",
  options: {
    storageKey: "zavi.homeChatWidth",
    min: 340,
    maxFraction: 0.4,
    round: "max",
    defaultPx: 405,
    resetTo: 405,
  },
  current: CURRENT_clampChatWidth,
  storageKey: "zavi.homeChatWidth",
  currentDefault: (vw) => CURRENT_clampChatWidth(405, vw),
};

const WEBSITE_TAB: SurfaceConfig = {
  name: "WebsiteTab",
  options: {
    storageKey: "zavi.websiteChatWidth",
    min: 340,
    maxFraction: 0.4,
    round: "max",
    defaultPx: 405,
    resetTo: 405,
  },
  current: CURRENT_clampChatWidth,
  storageKey: "zavi.websiteChatWidth",
  currentDefault: (vw) => CURRENT_clampChatWidth(405, vw),
};

const BRAINSTORM_PANEL: SurfaceConfig = {
  name: "BrainstormPanel",
  options: {
    min: 400,
    maxFraction: 0.85,
    round: "result",
    defaultFn: (vw) => vw * 0.4,
    initialSizePx: null,
    rehydrate: false,
    reclampOnResize: false,
    setBodyCursor: false,
    trackDragging: false,
    permanentListeners: true,
    resetTo: (current, vw) => {
      const narrow = CURRENT_clampW(vw * 0.4, vw);
      const wide = CURRENT_clampW(vw * 0.7, vw);
      return current !== null && current >= (narrow + wide) / 2 ? narrow : wide;
    },
    resetOnDoubleClick: false,
  },
  current: CURRENT_clampW,
  storageKey: undefined,
  currentDefault: (vw) => CURRENT_clampW(vw * 0.4, vw),
};

const SURFACES = [AGENT_TAB, CALM_HOME, WEBSITE_TAB, BRAINSTORM_PANEL];

const VIEWPORTS = [320, 640, 900, 1024, 1280, 1440, 1920, 2560, 3840, 100];
const INPUTS = [
  -500, 0, 1, 100, 339, 340, 341, 399, 400, 401, 405, 420, 500, 700, 900, 1200,
  1600, 2400, 5000, 100000,
];

function setViewport(px: number) {
  Object.defineProperty(window, "innerWidth", {
    value: px,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setViewport(1440);
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("makeClamp — behavior parity with the four current implementations", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const clamp = makeClamp(surface.options);

      it("matches the current clamp for every (input, viewport) pair", () => {
        const mismatches: string[] = [];
        for (const vw of VIEWPORTS) {
          for (const px of INPUTS) {
            const got = clamp(px, vw);
            const want = surface.current(px, vw);
            if (got !== want) {
              mismatches.push(`px=${px} vw=${vw}: got ${got}, want ${want}`);
            }
          }
        }
        expect(mismatches).toEqual([]);
      });

      it("matches on fractional viewports, where the rounding placement shows", () => {
        for (const vw of [1023.5, 1237.3, 999.9, 470.6, 2001.7]) {
          for (const px of [340, 400, 409.4, 410, 800, 1700]) {
            expect(clamp(px, vw)).toBe(surface.current(px, vw));
          }
        }
      });

      it("is idempotent", () => {
        for (const vw of VIEWPORTS) {
          for (const px of INPUTS) {
            const once = clamp(px, vw);
            expect(clamp(once, vw)).toBe(once);
          }
        }
      });

      it("never returns below min", () => {
        for (const vw of VIEWPORTS) {
          for (const px of INPUTS) {
            expect(clamp(px, vw)).toBeGreaterThanOrEqual(surface.options.min);
          }
        }
      });
    });
  }
});

describe("per-surface defaults and storage keys", () => {
  it.each(SURFACES.map((s) => [s.name, s] as const))(
    "%s starts at its current default",
    (_name, surface) => {
      const vw = 1440;
      setViewport(vw);
      const { result } = renderHook(() => useResizablePane(surface.options));
      expect(result.current.sizePx).toBe(surface.currentDefault(vw));
    },
  );

  it.each(
    SURFACES.filter((s) => s.storageKey).map((s) => [s.name, s] as const),
  )("%s rehydrates from its own key", (_name, surface) => {
    window.localStorage.setItem(surface.storageKey!, "900");
    const { result } = renderHook(() => useResizablePane(surface.options));
    expect(result.current.sizePx).toBe(surface.current(900, 1440));
  });

  it("a user's dragged 900px survives migration verbatim on a viewport that allows it", () => {
    setViewport(2560);
    window.localStorage.setItem("zavi.agentChatWidth", "900");
    const { result } = renderHook(() => useResizablePane(AGENT_TAB.options));
    expect(result.current.sizePx).toBe(900);
    expect(CURRENT_clampChatWidth(900, 2560)).toBe(900);
  });

  it("the three chat columns use three DIFFERENT keys", () => {
    const keys = [AGENT_TAB, CALM_HOME, WEBSITE_TAB].map((s) => s.storageKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      "zavi.agentChatWidth",
      "zavi.homeChatWidth",
      "zavi.websiteChatWidth",
    ]);
  });

  it("ignores a garbage or non-positive stored value and falls back to the default", () => {
    for (const bad of ["", "abc", "0", "-40", "NaN"]) {
      window.localStorage.setItem("zavi.agentChatWidth", bad);
      const { result, unmount } = renderHook(() => useResizablePane(AGENT_TAB.options));
      expect(result.current.sizePx).toBe(CURRENT_clampChatWidth(420, 1440));
      unmount();
    }
  });

  it("BrainstormPanel does not read or write localStorage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    act(() => result.current.setSize(700));
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("BrainstormPanel renders null before mount effects and never persists", () => {
    expect(BRAINSTORM_PANEL.options.initialSizePx).toBeNull();
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    expect(result.current.sizePx).toBe(BRAINSTORM_PANEL.currentDefault(1440));
  });
});

describe("drag mechanics", () => {
  function mouseDown() {
    return { preventDefault: vi.fn() } as unknown as React.MouseEvent;
  }
  function move(clientX: number) {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
  }
  function up() {
    window.dispatchEvent(new MouseEvent("mouseup"));
  }

  it("drag sets width = viewport - clientX, clamped", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(AGENT_TAB.options));
    act(() => result.current.startResize(mouseDown()));
    act(() => move(940));
    expect(result.current.sizePx).toBe(CURRENT_clampChatWidth(500, 1440));
    act(() => up());
  });

  it("the three chat columns persist the final width on mouseup", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(CALM_HOME.options));
    act(() => result.current.startResize(mouseDown()));
    act(() => move(940));
    expect(window.localStorage.getItem("zavi.homeChatWidth")).toBeNull();
    act(() => up());
    expect(window.localStorage.getItem("zavi.homeChatWidth")).toBe(
      String(CURRENT_clampChatWidth(500, 1440)),
    );
  });

  it("trackDragging on: exposes a dragging flag and sets the body cursor", () => {
    const { result } = renderHook(() => useResizablePane(AGENT_TAB.options));
    expect(result.current.dragging).toBe(false);
    act(() => result.current.startResize(mouseDown()));
    expect(result.current.dragging).toBe(true);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");
    act(() => up());
    expect(result.current.dragging).toBe(false);
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
  });

  it("trackDragging off + setBodyCursor off: userSelect only, dragging stays false", () => {
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    act(() => result.current.startResize(mouseDown()));
    expect(result.current.dragging).toBe(false);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("");
    act(() => up());
    expect(document.body.style.userSelect).toBe("");
  });

  it("permanentListeners: a move BEFORE any mousedown does not resize", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    const before = result.current.sizePx;
    act(() => move(600));
    expect(result.current.sizePx).toBe(before);
    act(() => result.current.startResize(mouseDown()));
    act(() => move(600));
    expect(result.current.sizePx).toBe(CURRENT_clampW(840, 1440));
  });

  it("on-mousedown listeners are unbound after mouseup", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(AGENT_TAB.options));
    act(() => result.current.startResize(mouseDown()));
    act(() => move(940));
    act(() => up());
    const settled = result.current.sizePx;
    act(() => move(600));
    expect(result.current.sizePx).toBe(settled);
  });
});

describe("window resize re-clamp", () => {
  it("the three chat columns re-clamp so the 40% cap keeps holding", () => {
    setViewport(2560);
    window.localStorage.setItem("zavi.websiteChatWidth", "900");
    const { result } = renderHook(() => useResizablePane(WEBSITE_TAB.options));
    expect(result.current.sizePx).toBe(900);
    act(() => {
      setViewport(1280);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sizePx).toBe(CURRENT_clampChatWidth(900, 1280));
    expect(result.current.sizePx).toBe(512);
  });

  it("BrainstormPanel does NOT re-clamp on resize", () => {
    setViewport(2560);
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    const initial = result.current.sizePx;
    expect(initial).toBe(CURRENT_clampW(2560 * 0.4, 2560));
    act(() => {
      setViewport(700);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sizePx).toBe(initial);
  });
});

describe("reset", () => {
  it.each([
    ["AgentTab", AGENT_TAB, 420],
    ["CalmHome", CALM_HOME, 405],
    ["WebsiteTab", WEBSITE_TAB, 405],
  ] as const)("%s double-click resets to %s and persists", (_n, surface, target) => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(surface.options));
    act(() => result.current.setSize(560));
    expect(result.current.sizePx).toBe(560);
    act(() => result.current.resetSize());
    expect(result.current.sizePx).toBe(CURRENT_clampChatWidth(target, 1440));
    expect(window.localStorage.getItem(surface.storageKey!)).toBe(String(target));
    expect(result.current.separatorProps.onDoubleClick).toBeTypeOf("function");
  });

  it("BrainstormPanel toggleWide flips 40% ↔ 70% and is NOT on double-click", () => {
    const vw = 1440;
    setViewport(vw);
    const narrow = CURRENT_clampW(vw * 0.4, vw);
    const wide = CURRENT_clampW(vw * 0.7, vw);
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    expect(result.current.sizePx).toBe(narrow);
    expect(result.current.separatorProps.onDoubleClick).toBeUndefined();

    act(() => result.current.resetSize());
    expect(result.current.sizePx).toBe(wide);
    act(() => result.current.resetSize());
    expect(result.current.sizePx).toBe(narrow);
  });

  it("toggleWide picks narrow when the current width is past the midpoint", () => {
    const vw = 1440;
    setViewport(vw);
    const narrow = CURRENT_clampW(vw * 0.4, vw);
    const wide = CURRENT_clampW(vw * 0.7, vw);
    const { result } = renderHook(() => useResizablePane(BRAINSTORM_PANEL.options));
    act(() => result.current.setSize((narrow + wide) / 2 + 10));
    act(() => result.current.resetSize());
    expect(result.current.sizePx).toBe(narrow);
  });
});

describe("keyboard resize (opt-in)", () => {
  const base: UseResizablePaneOptions = {
    min: 300,
    maxFraction: 0.6,
    round: "max",
    defaultPx: 500,
    keyboard: true,
  };

  function key(k: string) {
    const preventDefault = vi.fn();
    return { key: k, preventDefault } as unknown as React.KeyboardEvent & {
      preventDefault: ReturnType<typeof vi.fn>;
    };
  }

  it("is OFF for all four migrated surfaces — no tabIndex, no key handler", () => {
    for (const surface of SURFACES) {
      const { result, unmount } = renderHook(() => useResizablePane(surface.options));
      expect(result.current.separatorProps.tabIndex).toBeUndefined();
      expect(result.current.separatorProps.onKeyDown).toBeUndefined();
      expect(result.current.separatorProps["aria-valuenow"]).toBeUndefined();
      unmount();
    }
  });

  it("makes the separator focusable when enabled", () => {
    const { result } = renderHook(() => useResizablePane(base));
    expect(result.current.separatorProps.tabIndex).toBe(0);
    expect(result.current.separatorProps.onKeyDown).toBeTypeOf("function");
  });

  it("ArrowLeft widens and ArrowRight narrows by the step (right-anchored pane)", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane({ ...base, keyboard: { step: 20 } }));
    expect(result.current.sizePx).toBe(500);
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowLeft")));
    expect(result.current.sizePx).toBe(520);
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowRight")));
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowRight")));
    expect(result.current.sizePx).toBe(480);
  });

  it("defaults to a 16px step and a 64px page step", () => {
    const { result } = renderHook(() => useResizablePane(base));
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowLeft")));
    expect(result.current.sizePx).toBe(516);
    act(() => result.current.separatorProps.onKeyDown!(key("PageUp")));
    expect(result.current.sizePx).toBe(580);
    act(() => result.current.separatorProps.onKeyDown!(key("PageDown")));
    expect(result.current.sizePx).toBe(516);
  });

  it("Home goes to min, End goes to max", () => {
    setViewport(1440);
    const { result } = renderHook(() => useResizablePane(base));
    act(() => result.current.separatorProps.onKeyDown!(key("Home")));
    expect(result.current.sizePx).toBe(300);
    act(() => result.current.separatorProps.onKeyDown!(key("End")));
    expect(result.current.sizePx).toBe(Math.round(1440 * 0.6));
  });

  it("Home/End can be disabled", () => {
    const { result } = renderHook(() =>
      useResizablePane({ ...base, keyboard: { homeEndKeys: false } }),
    );
    act(() => result.current.separatorProps.onKeyDown!(key("Home")));
    expect(result.current.sizePx).toBe(500);
  });

  it("keyboard steps stay clamped and ignore unrelated keys", () => {
    setViewport(1000);
    const { result } = renderHook(() => useResizablePane({ ...base, keyboard: { step: 400 } }));
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowRight")));
    expect(result.current.sizePx).toBe(300);
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowLeft")));
    act(() => result.current.separatorProps.onKeyDown!(key("ArrowLeft")));
    expect(result.current.sizePx).toBe(600);

    const before = result.current.sizePx;
    const e = key("a");
    act(() => result.current.separatorProps.onKeyDown!(e));
    expect(result.current.sizePx).toBe(before);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("preventDefault fires only for handled keys", () => {
    const { result } = renderHook(() => useResizablePane(base));
    const handled = key("ArrowLeft");
    act(() => result.current.separatorProps.onKeyDown!(handled));
    expect(handled.preventDefault).toHaveBeenCalled();
  });
});

describe("aria value reporting", () => {
  it("reports valuenow/min/max against the live viewport when enabled", () => {
    setViewport(1440);
    const { result } = renderHook(() =>
      useResizablePane({ min: 300, maxFraction: 0.6, round: "max", defaultPx: 500, keyboard: true }),
    );
    const p = result.current.separatorProps;
    expect(p["aria-valuenow"]).toBe(500);
    expect(p["aria-valuemin"]).toBe(300);
    expect(p["aria-valuemax"]).toBe(864);
    expect(p["aria-valuetext"]).toBe("500 pixels");
  });

  it("can be exposed without enabling keyboard resize", () => {
    const { result } = renderHook(() =>
      useResizablePane({
        min: 300,
        maxFraction: 0.6,
        round: "max",
        defaultPx: 500,
        exposeAriaValues: true,
      }),
    );
    expect(result.current.separatorProps["aria-valuenow"]).toBe(500);
    expect(result.current.separatorProps.tabIndex).toBeUndefined();
  });

  it("always carries role=separator and an accessible name", () => {
    const { result } = renderHook(() =>
      useResizablePane({ ...AGENT_TAB.options, ariaLabel: "Resize chat" }),
    );
    expect(result.current.separatorProps.role).toBe("separator");
    expect(result.current.separatorProps["aria-orientation"]).toBe("vertical");
    expect(result.current.separatorProps["aria-label"]).toBe("Resize chat");
  });
});

describe("percentage sizing + onCommit", () => {
  it("derives sizePct from the live viewport", () => {
    setViewport(1000);
    const { result } = renderHook(() =>
      useResizablePane({ min: 100, maxFraction: 0.9, defaultPx: 300 }),
    );
    expect(result.current.sizePct).toBeCloseTo(30, 6);
    act(() => {
      setViewport(2000);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sizePct).toBeCloseTo(15, 6);
  });

  it("a pct default is expressible through defaultFn", () => {
    setViewport(1600);
    const { result } = renderHook(() =>
      useResizablePane({ min: 100, maxFraction: 0.9, defaultFn: (vw) => vw * 0.35 }),
    );
    expect(result.current.sizePx).toBe(560);
    expect(result.current.sizePct).toBeCloseTo(35, 6);
  });

  it("onCommit fires with (pct, px) on drag end, reset, and keyboard step", () => {
    setViewport(1000);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useResizablePane({
        min: 100,
        maxFraction: 0.9,
        defaultPx: 300,
        resetTo: 300,
        keyboard: { step: 50 },
        onCommit,
      }),
    );

    act(() => result.current.startResize({ preventDefault: vi.fn() } as unknown as React.MouseEvent));
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600 })));
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(onCommit).toHaveBeenLastCalledWith(40, 400);

    act(() => result.current.separatorProps.onKeyDown!({
      key: "ArrowLeft",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent));
    expect(onCommit).toHaveBeenLastCalledWith(45, 450);

    act(() => result.current.resetSize());
    expect(onCommit).toHaveBeenLastCalledWith(30, 300);
  });

  it("does NOT fire mid-drag — only on commit", () => {
    setViewport(1000);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useResizablePane({ min: 100, maxFraction: 0.9, defaultPx: 300, onCommit }),
    );
    act(() => result.current.startResize({ preventDefault: vi.fn() } as unknown as React.MouseEvent));
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 })));
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600 })));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("none of the four migrated surfaces configures onCommit", () => {
    for (const surface of SURFACES) {
      expect(surface.options.onCommit).toBeUndefined();
    }
  });
});
