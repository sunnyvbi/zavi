// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({
  useAppReadiness: () => ({ state: "ready", retry: () => {} }),
}));

import { PREVIEW_OVERLAY_FADE_MS, WebsitePreview } from "./WebsitePreview";
import {
  PREVIEW_RENDER_GAVE_UP,
  PREVIEW_RENDER_HELLO,
  PREVIEW_RENDER_MESSAGE,
  PREVIEW_RENDER_RELOAD_MS,
  PREVIEW_RENDER_STUCK_MS,
} from "@/lib/workspace/previewRender";
import { STILL_BUILDING_TITLE } from "@/lib/workspace/stillBuilding";

const APP_URL = "https://5173-box123.e2b.app";
const NOTE = "First draft. Zavi is writing your pages now.";

type Win = { postMessage: (msg: unknown, origin: string) => void };

function mount(props: Partial<Parameters<typeof WebsitePreview>[0]> = {}) {
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const sent: Array<{ msg: unknown; origin: string }> = [];
  const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={null} builtApp siteApp {...props} />);
  let win: Win = { postMessage: () => {} };
  const attach = () => {
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    win = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: win });
    return frame;
  };
  let frame = attach();
  const frames = new Set<HTMLIFrameElement>([frame]);
  const current = () => {
    const now = view.container.querySelector("iframe") as HTMLIFrameElement;
    if (!frames.has(now)) {
      frames.add(now);
      frame = attach();
    }
    return frame;
  };
  const say = (state: string, origin = APP_URL) => {
    current();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: PREVIEW_RENDER_MESSAGE, state }, origin, source: win as unknown as Window }));
    });
  };
  const load = () => fireEvent.load(current());
  return { view, say, load, sent, current };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  apiFetch.mockReset();
});

describe("WebsitePreview: a frame that did not render", () => {
  it("keeps the honest building screen over a loaded-but-empty first draft instead of a blank pane, and shows the page once it renders", () => {
    const p = mount({ buildingNote: NOTE });
    p.say("pending");
    p.load();
    expect(screen.getByTestId("preview-awaiting-render")).toBeTruthy();
    expect(screen.getByText(STILL_BUILDING_TITLE)).toBeTruthy();
    p.say("rendered");
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
    expect(screen.getByTestId("preview-loading-fading").getAttribute("aria-hidden")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(PREVIEW_OVERLAY_FADE_MS);
    });
    expect(screen.queryByText(STILL_BUILDING_TITLE)).toBeNull();
    expect(screen.getByTestId("preview-building-note").textContent).toContain(NOTE);
  });

  it("reloads a frame whose modules failed, with growing waits, and stops once it renders", () => {
    const p = mount({ buildingNote: NOTE });
    p.say("pending");
    p.load();
    p.say("failed");
    const first = p.current();
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[0]! - 1);
    });
    expect(p.current()).toBe(first);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const second = p.current();
    expect(second).not.toBe(first);
    expect(screen.getByText(STILL_BUILDING_TITLE)).toBeTruthy();
    p.say("pending");
    p.load();
    p.say("failed");
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[1]! - 1);
    });
    expect(p.current()).toBe(second);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(p.current()).not.toBe(second);
    p.say("pending");
    p.load();
    p.say("rendered");
    const settled = p.current();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(settled);
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
  });

  it("reloads a frame stuck at 'pending' (a module request that never answers)", () => {
    const p = mount();
    p.say("pending");
    p.load();
    const first = p.current();
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_STUCK_MS);
    });
    expect(p.current()).not.toBe(first);
  });

  it("is bounded: after the last reload it offers Try again, which starts over", () => {
    const p = mount();
    for (let i = 0; i < PREVIEW_RENDER_RELOAD_MS.length; i++) {
      p.say("pending");
      p.load();
      p.say("failed");
      act(() => {
        vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[i]!);
      });
    }
    p.say("pending");
    p.load();
    p.say("failed");
    const last = p.current();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(last);
    expect(screen.getByText(PREVIEW_RENDER_GAVE_UP)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(p.current()).not.toBe(last);
    expect(screen.queryByText(PREVIEW_RENDER_GAVE_UP)).toBeNull();
  });

  it("an empty page is reloaded once, then shown as it is (an app may render nothing on purpose)", () => {
    const p = mount();
    p.say("pending");
    p.load();
    p.say("empty");
    const first = p.current();
    expect(screen.getByTestId("preview-awaiting-render")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[0]!);
    });
    const second = p.current();
    expect(second).not.toBe(first);
    p.say("pending");
    p.load();
    p.say("empty");
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(second);
  });

  it("during a build a page that threw stays behind the building screen (no blank pane), and is not reloaded", () => {
    const p = mount({ buildingNote: NOTE });
    p.say("pending");
    p.load();
    p.say("errored");
    const frame = p.current();
    expect(screen.getByText(STILL_BUILDING_TITLE)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(frame);
    p.say("rendered");
    act(() => {
      vi.advanceTimersByTime(PREVIEW_OVERLAY_FADE_MS);
    });
    expect(screen.queryByText(STILL_BUILDING_TITLE)).toBeNull();
  });

  it("an app that threw shows the page (and its error), never reloads a code bug", () => {
    const p = mount();
    p.say("pending");
    p.load();
    p.say("errored");
    const frame = p.current();
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(frame);
  });

  it("never reloads while the founder is editing; picks up again when they stop", () => {
    const p = mount();
    p.say("pending");
    p.load();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready" }, origin: APP_URL, source: p.current().contentWindow }));
    });
    const edit = () => screen.getAllByRole("button", { name: /Edit/ })[0]!;
    fireEvent.click(edit());
    expect(edit().getAttribute("aria-pressed")).toBe("true");
    p.say("failed");
    const frame = p.current();
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[0]! * 4);
    });
    expect(p.current()).toBe(frame);
    fireEvent.click(edit());
    act(() => {
      vi.advanceTimersByTime(PREVIEW_RENDER_RELOAD_MS[0]!);
    });
    expect(p.current()).not.toBe(frame);
  });

  it("changes nothing for a page that never sends the signal (a published or external site)", () => {
    const p = mount({ buildingNote: NOTE });
    p.load();
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
    expect(screen.queryByTestId("preview-loading")).toBeNull();
    const frame = p.current();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(p.current()).toBe(frame);
  });

  it("trusts only the framed origin and window, and asks the frame again once it loads", () => {
    const p = mount();
    p.say("failed", "https://evil.example");
    p.load();
    expect(screen.queryByTestId("preview-awaiting-render")).toBeNull();
    expect(p.sent).toContainEqual({ msg: { type: PREVIEW_RENDER_HELLO }, origin: APP_URL });
  });

  it("lifts the build note above the docked tools so it is never covered", () => {
    mount({ buildingNote: NOTE, editPlacement: "dock" });
    expect(screen.getByTestId("preview-building-note").className).toContain("bottom-[76px]");
    cleanup();
    mount({ buildingNote: NOTE });
    expect(screen.getByTestId("preview-building-note").className).toContain("bottom-4");
  });
});
