// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WebsitePreview, SITE_PICKER_MISSING_HINT, EDIT_ARM_GRACE_MS } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SANDBOX = "https://5173-sbx123.e2b.app";

function mountSite(opts: { siteApp?: boolean; onElementPicked?: (p: unknown) => void; onEditFallback?: () => void } = {}) {
  const view = render(
    <WebsitePreview
      liveUrl={SANDBOX}
      cacheKey={null}
      appId={opts.siteApp === false ? null : "site:site-1"}
      builtApp={opts.siteApp ?? true}
      siteApp={opts.siteApp ?? true}
      onElementPicked={opts.onElementPicked}
      onEditFallback={opts.onEditFallback}
      editPlacement="dock"
    />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  fireEvent.load(frame);
  const posted: Array<{ type?: string; enabled?: boolean }> = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (msg: { type?: string; enabled?: boolean }) => posted.push(msg) },
  });
  const fromApp = (data: unknown, origin = SANDBOX) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame.contentWindow }));
    });
  return {
    fromApp,
    posted,
    clickEdit: () => fireEvent.click(screen.getByRole("button", { name: /^Edit/ })),
    editPressed: () => screen.getByRole("button", { name: /^Edit/ }).getAttribute("aria-pressed"),
    pickerSets: () => posted.filter((m) => m.type === "zavi:picker-set"),
    hint: () => screen.queryByRole("status")?.textContent ?? null,
  };
}

describe("click-to-edit on a new-builder site's preview", () => {
  it("arms the picker on the first click once the preview's picker has announced itself", () => {
    const onEditFallback = vi.fn();
    const app = mountSite({ onEditFallback });
    app.fromApp({ type: "zavi:picker-ready" });
    app.clickEdit();
    expect(app.posted.filter((m) => m.type === "zavi:picker-set").at(-1)).toEqual({ type: "zavi:picker-set", enabled: true });
    expect(app.hint()).toBeNull();
    expect(onEditFallback).not.toHaveBeenCalled();
  });

  it("hands the picked element to the chat", () => {
    const onElementPicked = vi.fn();
    const app = mountSite({ onElementPicked });
    app.fromApp({ type: "zavi:picker-ready" });
    app.clickEdit();
    app.fromApp({ type: "zavi:element-picked", selector: "section.hero h1", tag: "h1" });
    expect(onElementPicked).toHaveBeenCalledWith(expect.objectContaining({ selector: "section.hero h1", tag: "h1" }));
  });

  it("ignores a pick from any origin other than the framed preview", () => {
    const onElementPicked = vi.fn();
    const app = mountSite({ onElementPicked });
    app.fromApp({ type: "zavi:picker-ready" });
    app.clickEdit();
    app.fromApp({ type: "zavi:element-picked", selector: "h1", tag: "h1" }, "https://evil.example.com");
    expect(onElementPicked).not.toHaveBeenCalled();
  });

  it("keeps the picker on through the editor grace window instead of arming an editor that never loads", () => {
    vi.useFakeTimers();
    const onEditFallback = vi.fn();
    const app = mountSite({ onEditFallback });
    app.fromApp({ type: "zavi:picker-ready" });
    app.clickEdit();
    act(() => {
      vi.advanceTimersByTime(EDIT_ARM_GRACE_MS + 100);
    });
    expect(app.pickerSets()).toEqual([{ type: "zavi:picker-set", enabled: true }]);
    expect(app.editPressed()).toBe("true");
    expect(app.hint()).toBeNull();
    expect(onEditFallback).not.toHaveBeenCalled();
  });

  it("turns the picker off on the second click of Edit", () => {
    vi.useFakeTimers();
    const app = mountSite();
    app.fromApp({ type: "zavi:picker-ready" });
    app.clickEdit();
    app.clickEdit();
    expect(app.pickerSets().at(-1)).toEqual({ type: "zavi:picker-set", enabled: false });
    expect(app.editPressed()).toBe("false");
    act(() => {
      vi.advanceTimersByTime(EDIT_ARM_GRACE_MS + 100);
    });
    expect(app.pickerSets()).toHaveLength(2);
    expect(app.editPressed()).toBe("false");
  });

  it("still opens the full editor when the site preview's editor runtime is ready", () => {
    const app = mountSite();
    app.fromApp({ type: "zavi:picker-ready" });
    app.fromApp({ type: "zavi:editor-ready", protocol: 2 });
    app.clickEdit();
    expect(app.pickerSets()).toEqual([]);
    expect(app.editPressed()).toBe("true");
  });

  it("never calls the founder's own Zavi site an external site when the picker has not loaded", () => {
    vi.useFakeTimers();
    const onEditFallback = vi.fn();
    const app = mountSite({ onEditFallback });
    app.clickEdit();
    act(() => {
      vi.advanceTimersByTime(EDIT_ARM_GRACE_MS + 100);
    });
    expect(app.hint()).toBe(SITE_PICKER_MISSING_HINT);
    expect(app.hint()).not.toMatch(/external site/i);
    expect(onEditFallback).toHaveBeenCalledTimes(1);
  });

  it("still says external site for a site that is not one of the founder's Zavi sites", () => {
    const app = mountSite({ siteApp: false });
    app.clickEdit();
    expect(app.hint()).toMatch(/external site/i);
  });
});
