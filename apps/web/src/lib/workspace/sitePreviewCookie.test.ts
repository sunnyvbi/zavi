// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveFrameSrc, noteSitePreviewCookie, SITE_PREVIEW_COOKIE_KEY } from "./sitePreviewCookie";

const NOW = Date.parse("2026-10-02T13:00:00Z");
const ENTRY = "https://bike.zaviagent.com/__zavi_preview/d0muqzh2uy-1d58fa82/?t=x&zavi_embed=1";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("after a site version was opened, the live frame clears its cookie first", () => {
  it("routes that site's live pages through the end path, keeping the page and query", () => {
    noteSitePreviewCookie(ENTRY, NOW + 15 * 60_000, NOW);
    expect(liveFrameSrc("https://bike.zaviagent.com/", NOW)).toBe("https://bike.zaviagent.com/__zavi_preview_end?next=%2F");
    expect(liveFrameSrc("https://bike.zaviagent.com/menu?_v=3", NOW)).toBe("https://bike.zaviagent.com/__zavi_preview_end?next=%2Fmenu%3F_v%3D3");
  });

  it("leaves every other address alone: another site, a sandbox preview, the version link itself", () => {
    noteSitePreviewCookie(ENTRY, NOW + 15 * 60_000, NOW);
    expect(liveFrameSrc("https://car.zaviagent.com/", NOW)).toBe("https://car.zaviagent.com/");
    expect(liveFrameSrc("https://3000-sbx.e2b.app/", NOW)).toBe("https://3000-sbx.e2b.app/");
    expect(liveFrameSrc(ENTRY, NOW)).toBe(ENTRY);
  });

  it("stops rewriting once the cookie could no longer exist, and forgets the mark", () => {
    noteSitePreviewCookie(ENTRY, NOW + 15 * 60_000, NOW);
    expect(liveFrameSrc("https://bike.zaviagent.com/", NOW + 15 * 60_000 + 1)).toBe("https://bike.zaviagent.com/");
    expect(window.localStorage.getItem(SITE_PREVIEW_COOKIE_KEY)).toBeNull();
  });

  it("with no version opened, nothing is rewritten (no dependency on the Worker route)", () => {
    expect(liveFrameSrc("https://bike.zaviagent.com/", NOW)).toBe("https://bike.zaviagent.com/");
    noteSitePreviewCookie("https://bike.zaviagent.com/menu", NOW + 60_000, NOW);
    expect(liveFrameSrc("https://bike.zaviagent.com/", NOW)).toBe("https://bike.zaviagent.com/");
  });

  it("blocked storage never breaks the frame", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => noteSitePreviewCookie(ENTRY, NOW + 60_000, NOW)).not.toThrow();
    expect(liveFrameSrc("https://bike.zaviagent.com/", NOW)).toBe("https://bike.zaviagent.com/");
  });
});
