// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview, EDIT_ARM_GRACE_MS } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const APP_URL = "https://my-shop.zaviagent.com";

function mountAt(
  opts: { builtApp?: boolean; onEditFallback?: () => void; editPlacement?: "header" | "dock" } = {},
) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const view = render(
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId="my-shop.zaviagent.com"
      builtApp={opts.builtApp ?? true}
      onEditFallback={opts.onEditFallback}
      editPlacement={opts.editPlacement}
    />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  fireEvent.load(frame);
  const posted: Array<{ type?: string; enabled?: boolean }> = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: {
      postMessage: (msg: { type?: string; enabled?: boolean }) => {
        posted.push(msg);
      },
    },
  });
  const fromApp = (data: unknown) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }),
      );
    });
  const picker = () => {
    const sent = posted.filter((m) => m.type === "zavi:picker-set");
    return sent.length > 0 ? sent[sent.length - 1].enabled === true : false;
  };
  return {
    fromApp,
    pickerArmed: picker,
    tick: (ms: number) => act(() => { vi.advanceTimersByTime(ms); }),
    clickEdit: () => fireEvent.click(screen.getByRole("button", { name: /^Edit/ })),
    armed: () => screen.queryByRole("button", { name: /^Editing/ }) !== null,
    hint: () => screen.queryByRole("status")?.textContent ?? null,
  };
}

describe.each(["header", "dock"] as const)("clicking Edit (%s) before the app's runtime has announced itself", (editPlacement) => {
  const mount = (opts: Parameters<typeof mountAt>[0] = {}) => mountAt({ editPlacement, ...opts });
  it("arms the inline editor when ready lands after the click", () => {
    const app = mount();
    app.clickEdit();
    expect(app.armed()).toBe(true);

    app.tick(EDIT_ARM_GRACE_MS - 1);
    app.fromApp({ type: "zavi:editor-ready" });
    app.tick(EDIT_ARM_GRACE_MS * 2);

    expect(app.armed()).toBe(true);
    expect(app.hint()).toBeNull();
  });

  it("does not need a second click — one click survives the ready handshake", () => {
    const app = mount();
    app.clickEdit();
    app.tick(500);
    app.fromApp({ type: "zavi:editor-ready" });
    app.tick(EDIT_ARM_GRACE_MS * 2);

    expect(app.armed()).toBe(true);
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  });

  it("takes the legacy picker when only that answers in time", () => {
    const app = mount();
    app.clickEdit();
    app.fromApp({ type: "zavi:picker-ready" });
    app.tick(EDIT_ARM_GRACE_MS + 1);

    expect(app.armed()).toBe(true);
    expect(app.hint()).toBeNull();
  });

  it("gives up honestly when nothing answers, and hands the ask to the chat", () => {
    const onEditFallback = vi.fn();
    const app = mount({ onEditFallback });
    app.clickEdit();
    app.tick(EDIT_ARM_GRACE_MS + 1);

    expect(app.armed()).toBe(false);
    expect(app.hint()).toMatch(/didn’t load|describe your change/i);
    expect(onEditFallback).toHaveBeenCalledTimes(1);
  });

  it("lets a second click cancel a pending arm instead of queueing another", () => {
    const app = mount();
    app.clickEdit();
    expect(app.armed()).toBe(true);
    app.clickEdit();
    expect(app.armed()).toBe(false);

    app.tick(EDIT_ARM_GRACE_MS * 2);
    expect(app.hint()).toBeNull();
  });

  it("disarms the legacy picker when the runtime turns up late", () => {
    const app = mount();
    app.clickEdit();
    app.fromApp({ type: "zavi:picker-ready" });
    app.tick(EDIT_ARM_GRACE_MS + 1);
    expect(app.armed()).toBe(true);
    expect(app.pickerArmed()).toBe(true);

    app.fromApp({ type: "zavi:editor-ready" });
    app.clickEdit();
    app.tick(EDIT_ARM_GRACE_MS * 2);

    expect(app.armed()).toBe(true);
    expect(app.pickerArmed()).toBe(false);
  });

  it("says so at once for an external site, which can never carry the runtime", () => {
    const onEditFallback = vi.fn();
    const app = mount({ builtApp: false, onEditFallback });
    app.clickEdit();

    expect(app.armed()).toBe(false);
    expect(app.hint()).toMatch(/external site/i);
    expect(onEditFallback).toHaveBeenCalledTimes(1);
  });
});

describe("the docked Edit control", () => {
  it("leaves the bar for the host's own controls and floats over the preview", () => {
    const app = mountAt({ editPlacement: "dock" });
    const chrome = screen.getByTestId("preview-chrome");
    const tools = screen.getByRole("toolbar", { name: "Preview tools" });
    expect(chrome.contains(tools)).toBe(false);
    expect(within(chrome).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(tools.contains(screen.getByRole("button", { name: /^Edit/ }))).toBe(true);
    app.clickEdit();
    expect(screen.getByRole("button", { name: /^Editing/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Exit edit mode" }));
    expect(app.armed()).toBe(false);
  });

  it("renders the host's leading slot at the start of the bar", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <WebsitePreview
        liveUrl={APP_URL}
        cacheKey={null}
        appId="my-shop.zaviagent.com"
        builtApp
        editPlacement="dock"
        leading={<div data-testid="tabs" />}
      />,
    );
    expect(screen.getByTestId("preview-chrome").contains(screen.getByTestId("tabs"))).toBe(true);
  });

  it("has no dock before there is an app to edit", () => {
    render(<WebsitePreview liveUrl={null} cacheKey={null} appId={null} builtApp editPlacement="dock" />);
    expect(screen.queryByRole("toolbar", { name: "Preview tools" })).toBeNull();
  });
});
