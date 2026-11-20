// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/workspace" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}` }));
const consent = vi.hoisted(() => ({ writes: [] as unknown[] }));
vi.mock("@/lib/consent", () => ({
  OPEN_PREFERENCES_EVENT: "zavi:open-cookie-preferences",
  hasAnalyticsConsent: () => true,
  readConsent: () => ({ status: "unset" }),
  signalsRejection: () => false,
  subscribe: () => () => {},
  withdrawAnalyticsConsent: () => consent.writes.push("reject"),
  writeConsent: (c: unknown) => consent.writes.push(c),
}));

import { CookieBanner } from "./CookieBanner";
import { BUILD_FRAMING_TIMEOUT_MS, resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";

let answer: () => Promise<Response>;
const fetchMock = vi.fn((_url: string) => answer());
const flags = (body: Record<string, unknown>) => {
  answer = async () => ({ ok: true, status: 200, json: async () => body }) as Response;
};

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const banner = () => screen.queryByRole("region", { name: "Cookie consent" });
const classes = () => banner()!.className.split(/\s+/);

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockClear();
  consent.writes = [];
  nav.path = "/workspace";
  try {
    window.sessionStorage.clear();
  } catch {}
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("B27: the cookie banner never covers the workspace composer", () => {
  it("on /workspace it sits at the top, never the bottom, and still collects the choice", async () => {
    flags({ cookie_clear_of_composer: true });
    render(<CookieBanner />);
    await settle();
    expect(banner()).toBeTruthy();
    expect(banner()!.getAttribute("data-placement")).toBe("top");
    expect(classes()).toContain("top-4");
    expect(classes()).not.toContain("bottom-4");
    expect(classes()).not.toContain("sm:right-auto");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(consent.writes).toEqual([{ analytics: true }]);
  });

  it("on a workspace sub-page it is at the top too", async () => {
    flags({ cookie_clear_of_composer: true });
    nav.path = "/workspace/abc-123";
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("top");
  });

  it("shows nothing on /workspace until the setting answers, so it never flashes over the composer first", async () => {
    let release!: () => void;
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ cookie_clear_of_composer: true }) } as Response);
      });
    render(<CookieBanner />);
    await settle();
    expect(banner()).toBeNull();
    release();
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("top");
  });

  it("with the key off, the workspace keeps the bottom banner", async () => {
    flags({ cookie_clear_of_composer: false });
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("bottom");
    expect(classes()).toContain("bottom-4");
  });

  it("a failed settings read falls back to the key's default, the top banner, rather than the bottom one over the composer", async () => {
    answer = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("top");
    expect(classes()).not.toContain("bottom-4");
  });

  it("a settings read that throws also lands on the top banner", async () => {
    answer = async () => {
      throw new TypeError("Failed to fetch");
    };
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("top");
  });

  it("a settings read that hangs and ignores the abort holds the banner only until the 4 second cap, then shows it at the top", async () => {
    vi.useFakeTimers();
    try {
      answer = () => new Promise<Response>(() => {});
      render(<CookieBanner />);
      await settle();
      expect(banner()).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(BUILD_FRAMING_TIMEOUT_MS - 1);
      });
      await settle();
      expect(banner()).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await settle();
      expect(banner()!.getAttribute("data-placement")).toBe("top");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marketing pages put it at the top on a phone, in the bottom corner from sm up, and never ask for the setting", async () => {
    flags({ cookie_clear_of_composer: true });
    nav.path = "/pricing";
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("phone-top");
    expect(classes()).toEqual(expect.arrayContaining(["top-4", "sm:top-auto", "sm:bottom-4", "sm:right-auto"]));
    expect(classes()).not.toContain("bottom-4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a path that only starts with the word is not the workspace", async () => {
    flags({ cookie_clear_of_composer: true });
    nav.path = "/workspaces-guide";
    render(<CookieBanner />);
    await settle();
    expect(banner()!.getAttribute("data-placement")).toBe("phone-top");
  });
});

describe("the banner's padding", () => {
  it("uses the token pass's p-4 at every width, with no wider padding from the small breakpoint up", async () => {
    nav.path = "/";
    render(<CookieBanner />);
    await settle();
    expect(classes()).toContain("p-4");
    expect(classes().filter((c) => /^(sm|md|lg|xl|2xl):p-/.test(c) || c === "p-5")).toEqual([]);
  });
});
