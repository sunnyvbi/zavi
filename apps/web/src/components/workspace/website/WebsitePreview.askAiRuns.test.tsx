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

const APP_URL = "https://northline.zaviagent.com";
const RUNS = ["A quieter way to rent a car. ", "Northline opens the road soon."];
const NEW_RUNS = ["Rent a car, quietly. ", "Northline is almost here."];

describe("Ask AI on a heading with a styled second line", () => {
  it("sends the runs to resolve-edit and applies the returned runs to the preview", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === "/api/website/resolve-edit"
        ? { ok: true, json: async () => ({ patch: { segments: NEW_RUNS } }) }
        : { ok: true, json: async () => ({}) },
    );
    const view = render(
      <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="northline.zaviagent.com" builtApp />,
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
    fromApp({
      type: "zavi:editor-selected",
      selector: "main > h1",
      tag: "H1",
      text: "A quieter way to rent a car. Northline opens the road soon.",
      textEditable: false,
      segments: RUNS,
      style: {},
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit Element" }));

    const input = await screen.findByRole("textbox", { name: "Ask AI to change this element" });
    fireEvent.change(input, { target: { value: "polish it further" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(true);
    });
    const call = apiFetch.mock.calls.find(([p]) => p === "/api/website/resolve-edit")!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toMatchObject({ selector: "main > h1", segments: RUNS, message: "polish it further" });
    const applied = posted.find((m) => m.type === "zavi:editor-apply")!;
    expect(applied).toMatchObject({ selector: "main > h1", patch: { segments: NEW_RUNS } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
