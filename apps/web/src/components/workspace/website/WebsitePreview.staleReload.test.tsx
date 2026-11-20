// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const api = vi.hoisted(() => ({ saved: [] as Array<{ selector: string; patch: unknown; removed: boolean }> }));
const pill = vi.hoisted(() => ({ setOpen: null as null | ((open: boolean) => void) }));

vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) =>
    Promise.resolve({ ok: true, json: async () => (url.startsWith("/api/website/edits?") ? { edits: api.saved } : {}) }),
}));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));
vi.mock("./PreviewErrorPill", () => ({
  PreviewErrorPill: ({ onLogOpenChange }: { onLogOpenChange?: (open: boolean) => void }) => {
    pill.setOpen = onLogOpenChange ?? null;
    return null;
  },
}));

import { STALE_RUNTIME_RELOAD_MS, WebsitePreview } from "./WebsitePreview";

const APP_URL = "https://5173-sbx.e2b.app";
const APP_ID = "site:5f0c2a1e-1111-4222-8333-444455556666";

beforeEach(() => {
  api.saved = [];
  pill.setOpen = null;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function mountStale() {
  render(
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId={APP_ID}
      builtApp
      siteApp
      editPlacement="dock"
      onSendEdits={async () => ({ ok: true as const })}
      editsBusy={false}
    />,
  );
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready", protocol: 2 }, origin: APP_URL, source: frame.contentWindow as Window }));
  });
  await act(async () => {});
  return frame;
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("reloading an older preview runtime never throws away what the founder is doing", () => {
  it("reloads when nothing is in progress", async () => {
    const frame = await mountStale();
    await wait(STALE_RUNTIME_RELOAD_MS);
    expect(document.querySelector("iframe")).not.toBe(frame);
  });

  it("waits while the error log is open, and reloads once it is closed", async () => {
    const frame = await mountStale();
    act(() => pill.setOpen?.(true));
    await wait(STALE_RUNTIME_RELOAD_MS * 3);
    expect(document.querySelector("iframe")).toBe(frame);
    act(() => pill.setOpen?.(false));
    await wait(STALE_RUNTIME_RELOAD_MS);
    expect(document.querySelector("iframe")).not.toBe(frame);
  });

  it("does not reload while there are saved text changes not yet sent", async () => {
    api.saved = [{ selector: "main > h1", patch: { text: "Unsent" }, removed: false }];
    const frame = await mountStale();
    await wait(STALE_RUNTIME_RELOAD_MS * 3);
    expect(document.querySelector("iframe")).toBe(frame);
  });

  it("never reloads under an open edit or a typed draft, and reloads once it is resolved", async () => {
    const frame = await mountStale();
    const { fireEvent, screen } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "zavi:editor-selected", selector: "main > h1", tag: "H1", text: "Hi", textEditable: true, style: {}, protocol: 2 },
          origin: APP_URL,
          source: frame.contentWindow as Window,
        }),
      );
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Element text" }), { target: { value: "Hello" } });
    await wait(STALE_RUNTIME_RELOAD_MS * 3);
    expect(document.querySelector("iframe")).toBe(frame);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    await wait(STALE_RUNTIME_RELOAD_MS);
    expect(document.querySelector("iframe")).not.toBe(frame);
  });
});
