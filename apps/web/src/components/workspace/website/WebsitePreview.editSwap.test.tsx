// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WebsitePreview, EDIT_ARM_GRACE_MS, EDIT_SWAP_GRACE_MS } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LIVE_URL = "https://bike-rental-d667db97-05cd71-dev.zaviagent.com";
const SANDBOX_URL = "https://5173-iu810ilugbohjotn9gcsf.e2b.app";

function mount(opts: {
  url?: string;
  builtApp?: boolean;
  onEditUnavailable?: () => boolean;
  onEditFallback?: () => void;
  armEditOnLoad?: boolean;
}) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const url = opts.url ?? LIVE_URL;
  const view = render(
    <WebsitePreview
      liveUrl={url}
      cacheKey={null}
      appId="bike-rental-d667db97-05cd71-dev.zaviagent.com"
      builtApp={opts.builtApp ?? true}
      onEditUnavailable={opts.onEditUnavailable}
      onEditFallback={opts.onEditFallback}
      armEditOnLoad={opts.armEditOnLoad}
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
  return {
    posted,
    fromApp: (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: new URL(url).origin, source: frame.contentWindow }));
      }),
    tick: (ms: number) => act(() => { vi.advanceTimersByTime(ms); }),
    clickEdit: () => fireEvent.click(screen.getByRole("button", { name: /^Edit/ })),
    armed: () => screen.queryByRole("button", { name: /^Editing/ }) !== null,
    hint: () => screen.queryByRole("status")?.textContent ?? null,
  };
}

describe("edit on a framed page that never answers", () => {
  it("hands the click to the parent once the grace runs out, with no dead-end hint and no chat fallback", () => {
    const onEditUnavailable = vi.fn(() => true);
    const onEditFallback = vi.fn();
    const app = mount({ onEditUnavailable, onEditFallback });
    app.clickEdit();
    app.tick(EDIT_ARM_GRACE_MS - 1);
    expect(onEditUnavailable).not.toHaveBeenCalled();
    app.tick(2);
    expect(onEditUnavailable).toHaveBeenCalledTimes(1);
    expect(app.hint()).toBeNull();
    expect(onEditFallback).not.toHaveBeenCalled();
    expect(app.armed()).toBe(false);
  });

  it("an app that is not a built app hands off at once, without waiting", () => {
    const onEditUnavailable = vi.fn(() => true);
    const app = mount({ builtApp: false, onEditUnavailable });
    app.clickEdit();
    expect(onEditUnavailable).toHaveBeenCalledTimes(1);
    expect(app.hint()).toBeNull();
  });

  it("when the parent cannot help, the honest hint and the chat fallback stay", () => {
    const onEditUnavailable = vi.fn(() => false);
    const onEditFallback = vi.fn();
    const app = mount({ onEditUnavailable, onEditFallback });
    app.clickEdit();
    app.tick(EDIT_ARM_GRACE_MS + 1);
    expect(onEditUnavailable).toHaveBeenCalledTimes(1);
    expect(app.hint()).toMatch(/didn’t load|describe your change/i);
    expect(onEditFallback).toHaveBeenCalledTimes(1);
  });

  it("never asks the parent when the page answered", () => {
    const onEditUnavailable = vi.fn(() => true);
    const app = mount({ onEditUnavailable });
    app.fromApp({ type: "zavi:editor-ready" });
    app.clickEdit();
    app.tick(EDIT_ARM_GRACE_MS * 3);
    expect(onEditUnavailable).not.toHaveBeenCalled();
    expect(app.armed()).toBe(true);
  });
});

describe("a preview mounted to continue an edit", () => {
  it("turns edit mode on by itself when the slow sandbox announces well past the normal grace", () => {
    const app = mount({ url: SANDBOX_URL, armEditOnLoad: true });
    expect(app.armed()).toBe(true);
    app.tick(EDIT_ARM_GRACE_MS * 3);
    expect(app.hint()).toBeNull();
    app.fromApp({ type: "zavi:editor-ready" });
    expect(app.armed()).toBe(true);
    expect(app.posted.filter((m) => m.type === "zavi:editor-mode").at(-1)).toMatchObject({ enabled: true });
  });

  it("without the arm, a fresh preview stays out of edit mode", () => {
    const app = mount({ url: SANDBOX_URL });
    app.fromApp({ type: "zavi:editor-ready" });
    expect(app.armed()).toBe(false);
    expect(app.posted.filter((m) => m.type === "zavi:editor-mode").at(-1)).toMatchObject({ enabled: false });
  });

  it("gives up with the hint only after the longer grace when the sandbox never answers", () => {
    const onEditUnavailable = vi.fn(() => false);
    const app = mount({ url: SANDBOX_URL, armEditOnLoad: true, onEditUnavailable });
    app.tick(EDIT_SWAP_GRACE_MS - 10);
    expect(app.armed()).toBe(true);
    expect(app.hint()).toBeNull();
    app.tick(20);
    expect(app.armed()).toBe(false);
    expect(app.hint()).toMatch(/didn’t load|describe your change/i);
  });
});
