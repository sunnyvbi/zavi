// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(cleanup);

const APP_URL = "https://my-shop.zaviagent.com";

function mount(editPlacement: "header" | "dock" = "dock") {
  const view = render(
    <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="my-shop.zaviagent.com" builtApp editPlacement={editPlacement} />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Array<{ type?: string; enabled?: boolean }> = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (msg: { type?: string; enabled?: boolean }) => posted.push(msg) },
  });
  const send = (data: unknown, origin = APP_URL) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame.contentWindow }));
    });
  send({ type: "zavi:editor-ready" });
  const select = (origin = APP_URL) =>
    send({ type: "zavi:editor-selected", selector: "main > p:nth-of-type(1)", tag: "p", text: "Marlowe offers", style: {} }, origin);
  return { posted, send, select };
}

const tools = () => screen.getByRole("toolbar", { name: "Preview tools" });

describe("the docked preview tools while an element is selected", () => {
  it("swaps Edit and Annotate for a selection count and Clear", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    app.select();

    const selectionStatus = within(tools()).getByRole("status");
    expect(selectionStatus.textContent).toBe("1 selection");
    expect(selectionStatus.previousElementSibling?.className).toContain("bg-ink");
    expect(selectionStatus.previousElementSibling?.className).toContain("text-cream");
    expect(selectionStatus.previousElementSibling?.className).not.toContain("bg-[#3d6fe5]");
    expect(within(tools()).getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(within(tools()).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(tools()).queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  it("Clear drops the highlight in the app once and keeps edit mode armed", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    app.select();
    const before = app.posted.length;

    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));

    const sent = app.posted.slice(before);
    expect(sent.filter((m) => m.type === "zavi:editor-deselect")).toHaveLength(1);
    expect(sent.some((m) => m.type === "zavi:editor-mode" && m.enabled === false)).toBe(false);
    expect(within(tools()).queryByText("1 selection")).toBeNull();
    expect(within(tools()).getByRole("button", { name: "Editing" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("goes back to the tools when the app itself deselects, without echoing a deselect", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    app.select();
    const before = app.posted.length;

    app.send({ type: "zavi:editor-deselected" });

    expect(within(tools()).queryByText("1 selection")).toBeNull();
    expect(within(tools()).getByRole("button", { name: "Editing" })).toBeTruthy();
    expect(app.posted.slice(before).some((m) => m.type === "zavi:editor-deselect")).toBe(false);
  });

  it("ignores a selection from a foreign origin", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    app.select("https://evil.example.com");
    expect(within(tools()).queryByText("1 selection")).toBeNull();
  });

  it("is not shown while leaving edit mode drops the selection", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    app.select();
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(tools()).getByRole("button", { name: "Editing" }));
    app.select();
    expect(within(tools()).queryByText("1 selection")).toBeNull();
  });

  it("stays out of the header placement", () => {
    const app = mount("header");
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    app.select();
    expect(screen.queryByText("1 selection")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});
