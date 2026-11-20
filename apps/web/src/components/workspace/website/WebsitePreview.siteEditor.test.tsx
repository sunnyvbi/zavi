// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

import { WebsitePreview } from "./WebsitePreview";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const SANDBOX = "https://5173-sbx123.e2b.app";
const SITE_KEY = "site:aaaaaaaa-0000-4000-8000-000000000001";

type Msg = Record<string, unknown>;

function mount(drafts: Array<{ selector: string; patch: Msg; removed: boolean }> = []) {
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => (path.startsWith("/api/website/edits?") ? { edits: drafts } : { ok: true }),
  }));
  const view = render(
    <WebsitePreview liveUrl={SANDBOX} cacheKey={null} appId={SITE_KEY} builtApp siteApp editPlacement="dock" />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Msg[] = [];
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (m: Msg) => posted.push(m) } });
  const fromApp = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: SANDBOX, source: frame.contentWindow }));
    });
  return { posted, fromApp };
}

const writes = () =>
  apiFetch.mock.calls
    .filter(([p, i]) => p === "/api/website/edits" && (i as { method?: string } | undefined)?.method === "POST")
    .map(([, i]) => JSON.parse((i as { body: string }).body));

describe("the full inline editor on a site preview", () => {
  it("prefers the editor runtime over the picker and replays the site's saved drafts", async () => {
    const { posted, fromApp } = mount([{ selector: "h1.hero", patch: { text: "Fresh bread", before: { text: "Hi" } }, removed: false }]);
    fromApp({ type: "zavi:picker-ready" });
    fromApp({ type: "zavi:editor-ready" });
    await waitFor(() => expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/api/website/edits?app=${encodeURIComponent(SITE_KEY)}`);
    expect(posted.find((m) => m.type === "zavi:editor-apply")).toEqual({
      type: "zavi:editor-apply",
      selector: "h1.hero",
      patch: { text: "Fresh bread" },
      reveal: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    expect(posted.filter((m) => m.type === "zavi:editor-mode").at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true });
    expect(posted.some((m) => m.type === "zavi:picker-set")).toBe(false);
  });

  it("saves each edit under the site key with the element's state before the edit", async () => {
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-ready" });
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    fromApp({
      type: "zavi:editor-selected",
      selector: "h1.hero",
      tag: "H1",
      text: "Welcome",
      textEditable: true,
      style: { color: "rgb(0, 0, 0)" },
    });
    const input = await screen.findByRole("textbox", { name: "Element text" });
    fireEvent.change(input, { target: { value: "Fresh bread daily" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      app_id: SITE_KEY,
      selector: "h1.hero",
      patch: { text: "Fresh bread daily" },
      before: { text: "Welcome", style: { color: "rgb(0, 0, 0)" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete element" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({
      app_id: SITE_KEY,
      selector: "h1.hero",
      remove: true,
      before: { text: "Welcome", style: { color: "rgb(0, 0, 0)" } },
    });
  });
});
