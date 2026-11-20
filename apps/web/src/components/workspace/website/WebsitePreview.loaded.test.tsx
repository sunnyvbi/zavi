// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({
  useAppReadiness: () => ({ state: "ready", retry: () => {} }),
}));

import { READ_ONLY_PREVIEW_HINT, WebsitePreview } from "./WebsitePreview";
import { FIRST_DRAFT_MESSAGE, FIRST_DRAFT_SILENCE_MS } from "@/lib/workspace/firstView";

const APP_URL = "https://spoke.zaviagent.com";

function mount() {
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="spoke.zaviagent.com" builtApp />);
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const contentWindow = { postMessage: () => {} };
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
  const fromApp = (data: unknown, origin = APP_URL, source: unknown = contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
    });
  return { frame, fromApp };
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("WebsitePreview loaded state", () => {
  it("clears the loading screen when the app's runtime speaks, even if the load event never fires", () => {
    const { fromApp } = mount();
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    expect(screen.getByText("Loading your app…")).toBeTruthy();

    fromApp({ type: "zavi:editor-routes", routes: ["/", "/pricing"] });

    expect(screen.queryByTestId("preview-loading")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Loading your app…" })).toBeNull();
    expect(screen.getByTestId("preview-loading-fading").className).toMatch(/opacity-0/);
  });

  it("does not trust a message from another origin or another window as proof of load", () => {
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-ready" }, "https://evil.example");
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    fromApp({ type: "zavi:editor-ready" }, APP_URL, { postMessage: () => {} });
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
  });

  it("still clears on the plain load event", () => {
    const { frame } = mount();
    fireEvent.load(frame);
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("draws the frame with theme tokens so dark mode shows no light corners", () => {
    mount();
    const cls = screen.getByTestId("preview-frame").className;
    expect(cls).toContain("border-rule");
    expect(cls).toContain("bg-cream");
    expect(cls).toContain("rounded-2xl");
    expect(cls).not.toMatch(/bg-white|#ececec/);
    expect(screen.getByTestId("edit-frame-ring").className).toContain("rounded-[15px]");
  });

  it("a build's honest status line sits over the framed preview as a live region, and only when given", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} buildingNote="First draft. Zavi is writing your pages now." />);
    const note = screen.getByTestId("preview-building-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("First draft. Zavi is writing your pages now.");
    view.rerender(<WebsitePreview liveUrl={APP_URL} cacheKey={null} buildingNote={null} />);
    expect(screen.queryByTestId("preview-building-note")).toBeNull();
  });

  it("a read-only preview (a first draft) explains instead of editing, even when the editor runtime is ready", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={null} builtApp siteApp readOnly />);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    const contentWindow = { postMessage: () => {} };
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready" }, origin: APP_URL, source: contentWindow as unknown as Window }));
    });
    const edit = screen.getAllByRole("button", { name: /Edit/ })[0];
    fireEvent.click(edit);
    expect(screen.getAllByText(READ_ONLY_PREVIEW_HINT).length).toBeGreaterThan(0);
    expect(edit.getAttribute("aria-pressed")).not.toBe("true");
  });

  it("the framed page saying it is a first draft makes the preview read-only until it says it is gone", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="spoke.zaviagent.com" builtApp siteApp />);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    const contentWindow = { postMessage: () => {} };
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
    const fromApp = (data: unknown, origin = APP_URL) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin, source: contentWindow as unknown as Window }));
      });
    fromApp({ type: "zavi:editor-ready" });
    fromApp({ type: FIRST_DRAFT_MESSAGE, shown: true }, "https://evil.example");
    fromApp({ type: FIRST_DRAFT_MESSAGE, shown: true });
    const edit = () => screen.getAllByRole("button", { name: /Edit/ })[0];
    fireEvent.click(edit());
    expect(screen.getAllByText(READ_ONLY_PREVIEW_HINT).length).toBeGreaterThan(0);
    expect(edit().getAttribute("aria-pressed")).not.toBe("true");

    fromApp({ type: FIRST_DRAFT_MESSAGE, shown: false });
    fireEvent.click(edit());
    expect(edit().getAttribute("aria-pressed")).toBe("true");
  });

  it("a draft that goes silent (the framed page reloaded without it) stops locking the preview", () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="spoke.zaviagent.com" builtApp siteApp />);
      const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
      const contentWindow = { postMessage: () => {} };
      Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
      const fromApp = (data: unknown) =>
        act(() => {
          window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: contentWindow as unknown as Window }));
        });
      fromApp({ type: "zavi:editor-ready" });
      fromApp({ type: FIRST_DRAFT_MESSAGE, shown: true });
      act(() => {
        vi.advanceTimersByTime(FIRST_DRAFT_SILENCE_MS - 1000);
      });
      fromApp({ type: FIRST_DRAFT_MESSAGE, shown: true });
      act(() => {
        vi.advanceTimersByTime(FIRST_DRAFT_SILENCE_MS - 1000);
      });
      const edit = () => screen.getAllByRole("button", { name: /Edit/ })[0];
      fireEvent.click(edit());
      expect(edit().getAttribute("aria-pressed")).not.toBe("true");
      act(() => {
        vi.advanceTimersByTime(FIRST_DRAFT_SILENCE_MS);
      });
      fireEvent.click(edit());
      expect(edit().getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});
