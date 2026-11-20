// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";
import { PREVIEW_TOOLS_STORAGE_KEY } from "./previewTools";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const APP_URL = "https://my-shop.zaviagent.com";

function mount(props: { surfaceActive?: boolean } = {}) {
  const view = render(
    <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="my-shop.zaviagent.com" builtApp editPlacement="dock" {...props} />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
  fireEvent.load(frame);
  const fromApp = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
    });
  fromApp({ type: "zavi:editor-ready" });
  return { view, fromApp };
}

const tools = () => screen.queryByRole("toolbar", { name: "Preview tools" });
const openMenu = () => fireEvent.click(within(tools()!).getByRole("button", { name: "More preview tools" }));
const menu = () => screen.getByRole("menu", { name: "Preview tools options" });
const press = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
const saved = () => JSON.parse(window.localStorage.getItem(PREVIEW_TOOLS_STORAGE_KEY) ?? "null");

describe("preview tools ⋯ menu", () => {
  it("offers Dock / Minimize / Hide with Dock checked, and a shortcuts switch with its list", () => {
    mount();
    openMenu();
    const items = within(menu()).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Dock", "Minimize", "Hide"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    const sw = within(menu()).getByRole("menuitemcheckbox", { name: /Keyboard shortcuts/ });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(within(menu()).getByRole("list", { name: "Shortcuts" }).textContent).toContain("Select an element");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(within(menu()).queryByRole("list", { name: "Shortcuts" })).toBeNull();
    expect(saved()).toEqual({ placement: "dock", shortcuts: false });
  });

  it("in dark mode the bar and the portaled menu follow the workspace theme instead of staying white", () => {
    document.documentElement.classList.add("dark");
    try {
      const shell = document.createElement("div");
      shell.className = "workspace-shell";
      document.body.appendChild(shell);
      render(
        <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="my-shop.zaviagent.com" builtApp editPlacement="dock" />,
        { container: shell },
      );
      const frame = shell.querySelector("iframe") as HTMLIFrameElement;
      Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
      fireEvent.load(frame);
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready" }, origin: APP_URL, source: frame.contentWindow }));
      });
      expect(tools()!.classList.contains("bg-cream")).toBe(true);
      expect(tools()!.classList.contains("bg-white")).toBe(false);
      expect(tools()!.closest(".workspace-shell")).toBe(shell);
      openMenu();
      expect(shell.contains(menu())).toBe(false);
      expect(menu().classList.contains("workspace-shell")).toBe(true);
      expect(menu().classList.contains("bg-cream")).toBe(true);
      expect(document.querySelector(".light-island")).toBeNull();
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("Minimize collapses the bar to one button that brings it back, and the choice is remembered", () => {
    mount();
    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Minimize" }));
    expect(tools()).toBeNull();
    expect(saved()).toEqual({ placement: "minimized", shortcuts: true });

    cleanup();
    mount();
    expect(tools()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show preview tools" }));
    expect(tools()).not.toBeNull();
    expect(saved().placement).toBe("dock");
  });

  it("Hide removes the bar, says how to get it back, and the chrome's eye button or ⌘. restores it", () => {
    mount();
    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Hide" }));
    expect(tools()).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/eye button/);
    const chrome = screen.getByTestId("preview-chrome");
    fireEvent.click(within(chrome).getByRole("button", { name: "Show preview tools" }));
    expect(tools()).not.toBeNull();

    press({ key: ".", metaKey: true });
    expect(tools()).toBeNull();
    press({ key: ".", ctrlKey: true });
    expect(tools()).not.toBeNull();
  });

  it("keyboard focus lands on the control that brings the tools back after Minimize or Hide", () => {
    mount();
    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Minimize" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Show preview tools");
    fireEvent.click(screen.getByRole("button", { name: "Show preview tools" }));
    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Hide" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Show preview tools");
    expect(screen.getByTestId("preview-chrome").contains(document.activeElement)).toBe(true);
  });

  it("Tab closes the menu back onto the ⋯ button", () => {
    mount();
    openMenu();
    fireEvent.keyDown(menu(), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("More preview tools");
  });

  it("Escape closes the menu and returns focus to the ⋯ button", () => {
    mount();
    openMenu();
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("More preview tools");
  });
});

describe("preview tools keyboard shortcuts", () => {
  it("A starts drawing and A again stops it", () => {
    mount();
    press({ key: "a" });
    expect(within(tools()!).getByText("Annotation")).toBeTruthy();
    press({ key: "a" });
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
  });

  it("E arms the element picker and E again leaves it", () => {
    mount();
    press({ key: "e" });
    expect(within(tools()!).getByRole("button", { name: "Editing" }).getAttribute("aria-pressed")).toBe("true");
    press({ key: "e" });
    expect(within(tools()!).getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("works for keys typed inside the app, which the runtime forwards", () => {
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-key", key: "a", metaKey: false, ctrlKey: false });
    expect(within(tools()!).getByText("Annotation")).toBeTruthy();
  });

  it("a key from inside the app can show the tools but never hide them", () => {
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-key", key: ".", metaKey: true, ctrlKey: false });
    expect(tools()).not.toBeNull();
    expect(saved()).toBeNull();

    press({ key: ".", metaKey: true });
    expect(tools()).toBeNull();
    fromApp({ type: "zavi:editor-key", key: ".", metaKey: true, ctrlKey: false });
    expect(tools()).not.toBeNull();
  });

  it("Escape typed inside the app leaves the mode that is on", () => {
    const { fromApp } = mount();
    press({ key: "a" });
    expect(within(tools()!).getByText("Annotation")).toBeTruthy();
    fromApp({ type: "zavi:editor-key", key: "Escape", metaKey: false, ctrlKey: false });
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
    press({ key: "e" });
    fromApp({ type: "zavi:editor-key", key: "Escape", metaKey: false, ctrlKey: false });
    expect(within(tools()!).getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("stands down while the preview is out of view", () => {
    const { fromApp } = mount({ surfaceActive: false });
    press({ key: "a" });
    fromApp({ type: "zavi:editor-key", key: "a", metaKey: false, ctrlKey: false });
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
  });

  it("ignores a forwarded key from anything but the framed app", () => {
    mount();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "zavi:editor-key", key: "a" }, origin: "https://evil.example", source: window }),
      );
    });
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
  });

  it("does nothing while typing in a field, or when shortcuts are switched off", () => {
    mount();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "a" }, input);
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
    input.remove();

    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitemcheckbox", { name: /Keyboard shortcuts/ }));
    press({ key: "a" });
    press({ key: ".", metaKey: true });
    expect(tools()).not.toBeNull();
    expect(within(tools()!).queryByText("Annotation")).toBeNull();
  });

  it("a mode started while the bar is hidden brings the bar back so it can be exited", () => {
    window.localStorage.setItem(PREVIEW_TOOLS_STORAGE_KEY, JSON.stringify({ placement: "hidden", shortcuts: true }));
    mount();
    expect(tools()).toBeNull();
    press({ key: "a" });
    expect(within(tools()!).getByText("Annotation")).toBeTruthy();
    press({ key: "Escape" });
    expect(tools()).toBeNull();
  });
});
