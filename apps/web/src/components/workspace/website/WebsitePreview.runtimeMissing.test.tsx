// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RUNTIME_MISSING_HINT, RUNTIME_RELOADS, RUNTIME_WAIT_MS, WebsitePreview } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) =>
    Promise.resolve({ ok: true, json: async () => (url.startsWith("/api/website/edits?") ? { edits: [] } : {}) }),
}));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const APP_URL = "https://sweet-layers-b896bdf2-734b79-dev.zaviagent.com";
const SITE_ID = "site:5f0c2a1e-1111-4222-8333-444455556666";

function frameOnScreen(): HTMLIFrameElement {
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  if (!("postMessage" in ((frame as unknown as { contentWindow?: object }).contentWindow ?? {}))) {
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
  }
  return frame;
}

function loaded(frame: HTMLIFrameElement) {
  fireEvent.load(frame);
}

function runtimeAnswers(frame: HTMLIFrameElement) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "zavi:editor-ready", protocol: 5 }, origin: APP_URL, source: frame.contentWindow as Window }),
    );
  });
}

function mount(site: boolean): HTMLIFrameElement {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId={site ? SITE_ID : "sweet-layers-b896bdf2-734b79-dev.zaviagent.com"}
      builtApp
      siteApp={site}
      editPlacement="dock"
      onSendEdits={async () => ({ ok: true })}
    />,
  );
  const frame = frameOnScreen();
  loaded(frame);
  return frame;
}

const tools = () => screen.getByRole("toolbar", { name: "Preview tools" });
const tool = (name: string) => within(tools()).queryByRole("button", { name });

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("a site preview whose page helper never answers", () => {
  it("shows Edit and Annotate only, reloads the frame once the wait is up, and gains Edit text and Theme when the reloaded helper answers", async () => {
    const first = mount(true);
    expect(tool("Edit")).not.toBeNull();
    expect(tool("Annotate")).not.toBeNull();
    expect(tool("Edit text")).toBeNull();
    expect(tool("Theme")).toBeNull();

    await wait(RUNTIME_WAIT_MS / 2);
    expect(document.querySelector("iframe")).toBe(first);
    await wait(RUNTIME_WAIT_MS / 2 + 100);
    const second = frameOnScreen();
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe(first.getAttribute("src"));

    loaded(second);
    runtimeAnswers(second);
    expect(tool("Edit text")).not.toBeNull();
    expect(tool("Theme")).not.toBeNull();

    await wait(RUNTIME_WAIT_MS * 2);
    expect(document.querySelector("iframe")).toBe(second);
    expect(screen.queryByText(RUNTIME_MISSING_HINT)).toBeNull();
  });

  it("a helper that answers in time keeps the frame as it is", async () => {
    const frame = mount(true);
    runtimeAnswers(frame);
    expect(tool("Theme")).not.toBeNull();
    await wait(RUNTIME_WAIT_MS * 2);
    expect(document.querySelector("iframe")).toBe(frame);
  });

  it("gives up after the bounded reloads and says the tools did not load", async () => {
    const frames = new Set<HTMLIFrameElement>([mount(true)]);
    for (let i = 0; i < RUNTIME_RELOADS; i++) {
      await wait(RUNTIME_WAIT_MS);
      const now = frameOnScreen();
      expect(frames.has(now)).toBe(false);
      frames.add(now);
      loaded(now);
    }
    expect(screen.queryAllByText(RUNTIME_MISSING_HINT)).toHaveLength(0);
    await wait(RUNTIME_WAIT_MS);
    expect(frames.has(frameOnScreen())).toBe(true);
    expect(screen.queryAllByText(RUNTIME_MISSING_HINT).length).toBeGreaterThan(0);
    expect(tool("Edit")).not.toBeNull();
    expect(tool("Theme")).toBeNull();
    await wait(RUNTIME_WAIT_MS * 2);
    expect(frames.has(frameOnScreen())).toBe(true);
  });

  it("never reloads under someone using the page, and reloads once they step out of it", async () => {
    const frame = mount(true);
    frame.tabIndex = 0;
    act(() => frame.focus());
    expect(document.activeElement).toBe(frame);
    await wait(RUNTIME_WAIT_MS * (RUNTIME_RELOADS + 2));
    expect(document.querySelector("iframe")).toBe(frame);
    expect(screen.queryAllByText(RUNTIME_MISSING_HINT)).toHaveLength(0);
    act(() => frame.blur());
    await wait(RUNTIME_WAIT_MS + 100);
    expect(document.querySelector("iframe")).not.toBe(frame);
  });

  it("waits longer than the page's own retries of the editor script (1s + 2s + 3s) before reloading", async () => {
    const frame = mount(true);
    await wait(6_000 + 3_000);
    expect(document.querySelector("iframe")).toBe(frame);
  });

  it("a site that is not Zavi-built is never reloaded for a missing helper", async () => {
    const frame = mount(false);
    await wait(RUNTIME_WAIT_MS * (RUNTIME_RELOADS + 2));
    expect(document.querySelector("iframe")).toBe(frame);
    expect(screen.queryByText(RUNTIME_MISSING_HINT)).toBeNull();
  });
});
