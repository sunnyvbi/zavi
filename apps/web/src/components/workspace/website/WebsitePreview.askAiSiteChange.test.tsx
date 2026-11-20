// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

import { WebsitePreview } from "./WebsitePreview";
import { SITE_CHANGE_STARTED } from "./websiteChatEdit";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const APP_URL = "https://maple-lane.zaviagent.com";
const REQUEST = 'On the page I\'m looking at, at the element `main > section h2` (it reads "Our cakes"): add a testimonials section below this';

function openToolbar(onRequestSiteChange?: (r: string) => Promise<{ ok: true } | { ok: false; message: string }>) {
  const view = render(
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId="site:aaaaaaaa-0000-4000-8000-000000000001"
      builtApp
      siteApp
      onRequestSiteChange={onRequestSiteChange}
    />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Array<Record<string, unknown>> = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
  });
  const fromApp = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
    });
  fromApp({ type: "zavi:editor-ready" });
  fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
  fromApp({ type: "zavi:editor-mode-ack", enabled: true });
  fromApp({ type: "zavi:editor-selected", selector: "main > section h2", tag: "H2", text: "Our cakes", textEditable: true, style: {} });
  return posted;
}

describe("Ask AI for more than the selected element", () => {
  it("offers the scoped site change and starts it on click, applying nothing to the element", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === "/api/website/resolve-edit"
        ? {
            ok: false,
            status: 409,
            json: async () => ({ error: { code: "needs_site_change", chat: "That needs a change to the site itself.", request: REQUEST } }),
          }
        : { ok: true, json: async () => ({}) },
    );
    const start = vi.fn(async () => ({ ok: true as const }));
    const posted = openToolbar(start);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Element" }));
    const input = await screen.findByRole("textbox", { name: "Ask AI to change this element" });
    fireEvent.change(input, { target: { value: "add a testimonials section below this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByRole("status")).textContent).toContain("That needs a change to the site itself.");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make this change" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(REQUEST));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(SITE_CHANGE_STARTED));
    expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(false);
    const call = apiFetch.mock.calls.find(([p]) => p === "/api/website/resolve-edit")!;
    expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ selector: "main > section h2", path: "/" });
  });

  it("any other refusal stays an inline error", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === "/api/website/resolve-edit"
        ? { ok: false, status: 422, json: async () => ({ error: { code: "no_editable_change", chat: "Try describing the text." } }) }
        : { ok: true, json: async () => ({}) },
    );
    openToolbar(vi.fn());
    fireEvent.click(await screen.findByRole("button", { name: "Edit Element" }));
    const input = await screen.findByRole("textbox", { name: "Ask AI to change this element" });
    fireEvent.change(input, { target: { value: "hmm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Try describing the text.");
    expect(screen.queryByRole("button", { name: "Make this change" })).toBeNull();
  });
});
