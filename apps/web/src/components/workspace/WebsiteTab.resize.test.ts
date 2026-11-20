// @vitest-environment jsdom

import { describe, it, expect } from "vitest";

import { makeClamp } from "@/hooks/useResizablePane";
import {
  WEBSITE_CHAT_PANE_OPTIONS,
  servableHostingUrls,
  shouldAutoExpandWebsiteChat,
  shouldShowWebsiteBuildProgress,
  websiteChatPaneOptions,
  websitePreviewKey,
} from "./WebsiteTab";
import { shouldExpandChatOnEngagement } from "./home/calm/HomeChatPanel";

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

const clamp = makeClamp(WEBSITE_CHAT_PANE_OPTIONS);

const { defaultPx, resetTo, storageKey } = WEBSITE_CHAT_PANE_OPTIONS;

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

describe("WebsiteTab chat column — equivalence with the pre-migration logic", () => {
  it("opens the desktop Build chat wider than the website side-channel", async () => {
    const { websiteChatDefaultPx } = await import("./WebsiteTab");
    expect(websiteChatDefaultPx("build")).toBeGreaterThan(websiteChatDefaultPx("website"));
  });
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

  it("a persisted width survives the round-trip EXACTLY — the 1200px promise", () => {
    expect(MIGRATED_mount("1200", 3000)).toBe(1200);
    expect(MIGRATED_mount("1200", 3840)).toBe(1200);
    for (const vw of [3000, 3840]) {
      expect(MIGRATED_mount("1200", vw)).toBe(CURRENT_mount("1200", vw));
    }
    expect(MIGRATED_mount("1200", 1920)).toBe(768);
    expect(MIGRATED_mount("1200", 1920)).toBe(CURRENT_mount("1200", 1920));
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

describe("WebsiteTab chat column — the options that pin the behavior", () => {
  it("gives the Build composer enough room even when an older narrow width is stored", () => {
    const build = websiteChatPaneOptions("build");
    expect(build.min).toBeGreaterThanOrEqual(420);
    expect(build.defaultPx).toBeGreaterThanOrEqual(460);
    expect(makeClamp(build)(340, 1440)).toBeGreaterThanOrEqual(420);
  });

  it("persists under its OWN key, distinct from the Calm home's", () => {
    expect(storageKey).toBe("zavi.websiteChatWidth");
    expect(storageKey).not.toBe("zavi.homeChatWidth");
    expect(WEBSITE_CHAT_PANE_OPTIONS.onCommit).toBeUndefined();
  });

  it("keeps the clamp spec exactly as it shipped", () => {
    expect(WEBSITE_CHAT_PANE_OPTIONS.min).toBe(340);
    expect(WEBSITE_CHAT_PANE_OPTIONS.maxFraction).toBe(0.4);
    expect(WEBSITE_CHAT_PANE_OPTIONS.round).toBe("max");
    expect(WEBSITE_CHAT_PANE_OPTIONS.maxPx).toBeUndefined();
    expect(WEBSITE_CHAT_PANE_OPTIONS.maxFn).toBeUndefined();
  });

  it("renders 405 before mount and defaults to 405 after", () => {
    expect(defaultPx).toBe(405);
    expect(WEBSITE_CHAT_PANE_OPTIONS.defaultFn).toBeUndefined();
    expect(WEBSITE_CHAT_PANE_OPTIONS.initialSizePx ?? defaultPx).toBe(405);
  });

  it("rehydrates, re-clamps on resize, and paints the body cursor", () => {
    expect(WEBSITE_CHAT_PANE_OPTIONS.rehydrate ?? !!storageKey).toBe(true);
    expect(WEBSITE_CHAT_PANE_OPTIONS.reclampOnResize ?? true).toBe(true);
    expect(WEBSITE_CHAT_PANE_OPTIONS.setBodyCursor ?? true).toBe(true);
  });

  it("tracks drag state in REACT STATE, not a ref", () => {
    expect(WEBSITE_CHAT_PANE_OPTIONS.trackDragging).toBe(true);
  });

  it("binds listeners per-drag, resets on double-click, and keeps the label", () => {
    expect(WEBSITE_CHAT_PANE_OPTIONS.permanentListeners ?? false).toBe(false);
    expect(resetTo).toBe(405);
    expect(WEBSITE_CHAT_PANE_OPTIONS.resetOnDoubleClick ?? resetTo !== undefined).toBe(true);
    expect(WEBSITE_CHAT_PANE_OPTIONS.ariaLabel).toBe("Resize chat");
    expect(WEBSITE_CHAT_PANE_OPTIONS.keyboard ?? false).toBe(false);
  });
});

describe("WebsiteTab chat column — preview-preserving prompt behavior", () => {
  it("keeps an existing website canvas visible when a prompt is sent", () => {
    const autoExpand = shouldAutoExpandWebsiteChat("https://app.example.com");
    expect(autoExpand).toBe(false);
    expect(shouldExpandChatOnEngagement(autoExpand, false)).toBe(false);
  });

  it("still lets chat use an empty canvas before the first preview exists", () => {
    const autoExpand = shouldAutoExpandWebsiteChat(null);
    expect(autoExpand).toBe(true);
    expect(shouldExpandChatOnEngagement(autoExpand, false)).toBe(true);
  });

  it("never covers a built app whose preview stopped: the restart panel needs the preview side", () => {
    const autoExpand = shouldAutoExpandWebsiteChat(null, false, true);
    expect(autoExpand).toBe(false);
    expect(shouldExpandChatOnEngagement(autoExpand, false)).toBe(false);
  });

  it("does not request another expansion when already expanded", () => {
    expect(shouldExpandChatOnEngagement(true, true)).toBe(false);
  });

  it("keeps the build visible instead of expanding chat over a running build", () => {
    const autoExpand = shouldAutoExpandWebsiteChat(null, true);
    expect(autoExpand).toBe(false);
    expect(shouldExpandChatOnEngagement(autoExpand, false)).toBe(false);
  });

  it("goes back to the empty-canvas behavior once no build is running", () => {
    expect(shouldAutoExpandWebsiteChat(null, false)).toBe(true);
    expect(shouldAutoExpandWebsiteChat(null)).toBe(true);
  });

  it("never expands over a real preview, building or not", () => {
    expect(shouldAutoExpandWebsiteChat("https://app.example.com", true)).toBe(false);
    expect(shouldAutoExpandWebsiteChat("https://app.example.com", false)).toBe(false);
  });
});

describe("WebsiteTab build progress visibility", () => {
  it("shows immediately from the local start signal, before status or preview resolves", () => {
    expect(
      shouldShowWebsiteBuildProgress(
        "https://stale-preview.example.com",
        false,
        true,
        false,
        0,
      ),
    ).toBe(true);
  });

  it("continues from server-confirmed build state after the start signal clears", () => {
    expect(shouldShowWebsiteBuildProgress(null, true, false, false, 0)).toBe(true);
  });

  it("keeps the real progress bar up while a build runs, even once an early preview address exists, until the app is ready", () => {
    expect(shouldShowWebsiteBuildProgress("https://5173-sbx.e2b.app", true, false, false, 0, false)).toBe(true);
    expect(shouldShowWebsiteBuildProgress("https://5173-sbx.e2b.app", true, false, false, 0, true)).toBe(false);
    expect(shouldShowWebsiteBuildProgress("https://5173-sbx.e2b.app", false, false, true, 1, false)).toBe(false);
    expect(shouldShowWebsiteBuildProgress("https://5173-sbx.e2b.app", true, false, false, 0)).toBe(false);
  });

  it("does not replace a settled preview when no build is starting", () => {
    expect(
      shouldShowWebsiteBuildProgress("https://app.example.com", false, false, false, 0),
    ).toBe(false);
  });
});

describe("servableHostingUrls", () => {
  const BUILTIN = "https://acme.zaviagent.com";
  const BUILT_APP = "https://acme-123.onrender.com";

  it("suppresses both hosting-derived URLs while a build is in flight", () => {
    expect(servableHostingUrls(true, BUILTIN, BUILT_APP)).toEqual({
      builtinLiveUrl: null,
      builtAppUrl: null,
    });
  });

  it("hands them straight back once no build is running", () => {
    expect(servableHostingUrls(false, BUILTIN, BUILT_APP)).toEqual({
      builtinLiveUrl: BUILTIN,
      builtAppUrl: BUILT_APP,
    });
  });

  it("leaves the resolution order intact for a settled tenant", () => {
    const hosted = servableHostingUrls(false, BUILTIN, BUILT_APP);
    expect(hosted.builtinLiveUrl ?? hosted.builtAppUrl).toBe(BUILTIN);
  });

  it("lets the probed build preview win mid-build, and step aside after", () => {
    const probed = "https://3000-abc.e2b.app";
    const midBuild = servableHostingUrls(true, BUILTIN, BUILT_APP);
    expect(midBuild.builtinLiveUrl ?? midBuild.builtAppUrl ?? probed).toBe(probed);

    const settled = servableHostingUrls(false, BUILTIN, BUILT_APP);
    expect(settled.builtinLiveUrl ?? settled.builtAppUrl ?? probed).toBe(BUILTIN);
  });
});

describe("websitePreviewKey", () => {
  it("is stable across post-run reload bumps (no remount, route survives)", () => {
    const url = "https://acme.zavi.app";
    const first = websitePreviewKey(url, 0);
    expect(websitePreviewKey(url, 1)).toBe(first);
    expect(websitePreviewKey(url, 2)).toBe(first);
    expect(websitePreviewKey(url, 99)).toBe(first);
  });

  it("still changes when the preview URL itself changes (real remount)", () => {
    expect(websitePreviewKey(null, 0)).not.toBe(websitePreviewKey("https://acme.zavi.app", 0));
    expect(websitePreviewKey("https://a.zavi.app", 3)).not.toBe(
      websitePreviewKey("https://b.zavi.app", 3),
    );
  });

  it("has a stable placeholder before any preview exists", () => {
    expect(websitePreviewKey(null, 0)).toBe(websitePreviewKey(null, 7));
  });
});
