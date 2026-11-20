// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview, type PreviewPick } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(cleanup);

const APP_URL = "https://my-shop.zaviagent.com";

function mount() {
  const picks: Array<PreviewPick | null> = [];
  const onSelectionChange = (p: PreviewPick | null) => picks.push(p);
  const ui = (clearSelectionKey: number) => (
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId="my-shop.zaviagent.com"
      builtApp
      editPlacement="dock"
      onSelectionChange={onSelectionChange}
      clearSelectionKey={clearSelectionKey}
    />
  );
  const view = render(ui(0));
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Array<{ type?: string }> = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (msg: { type?: string }) => posted.push(msg) },
  });
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
    });
  send({ type: "zavi:editor-ready" });
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
  const select = (selector = "main > h1", extra: Record<string, unknown> = {}) =>
    send({ type: "zavi:editor-selected", selector, tag: "h1", text: "Rent bikes fast", style: {}, ...extra });
  return { picks, posted, send, select, rerender: (k: number) => view.rerender(ui(k)) };
}

describe("the pick the chat composer's chip shows", () => {
  it("reports a new pick once, with its page, and a fresh id for each new element", () => {
    const app = mount();
    app.select();
    app.select();
    app.select("main > p:nth-of-type(2)");
    expect(app.picks).toHaveLength(2);
    expect(app.picks[0]).toMatchObject({ selector: "main > h1", tag: "h1", text: "Rent bikes fast", path: "/", src: null });
    expect(app.picks[1]!.id).toBeGreaterThan(app.picks[0]!.id);
  });

  it("resolves an image's address against the app", () => {
    const app = mount();
    app.send({ type: "zavi:editor-selected", selector: "main > img", tag: "img", text: "", style: {}, attrs: { src: "/photos/hero.jpg" } });
    expect(app.picks[0]).toMatchObject({ tag: "img", src: "https://my-shop.zaviagent.com/photos/hero.jpg" });
  });

  it("reports the founder clearing it, from the bar or from inside the app", () => {
    const app = mount();
    app.select();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Clear" }));
    expect(app.picks.at(-1)).toBeNull();
    app.select();
    app.send({ type: "zavi:editor-deselected" });
    expect(app.picks.at(-1)).toBeNull();
  });

  it("is dropped when the app moves to another page", () => {
    const app = mount();
    app.select();
    app.send({ type: "zavi:editor-location", path: "/about" });
    expect(app.picks.at(-1)).toBeNull();
  });

  it("Escape inside the app drops a pick kept across a frame reload", () => {
    const app = mount();
    app.select();
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(app.picks.at(-1)).not.toBeNull();
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    const win = frame.contentWindow ?? ({ postMessage: () => {} } as unknown as Window);
    if (!frame.contentWindow) Object.defineProperty(frame, "contentWindow", { configurable: true, value: win });
    fireEvent.load(frame);
    const fromFrame = (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
      });
    fromFrame({ type: "zavi:editor-ready" });
    fromFrame({ type: "zavi:editor-key", key: "Escape", metaKey: false, ctrlKey: false });
    expect(app.picks.at(-1)).toBeNull();
  });

  it("a host unpick deselects in the app", () => {
    const app = mount();
    app.select();
    const before = app.posted.length;
    app.rerender(1);
    expect(app.posted.slice(before).filter((m) => m.type === "zavi:editor-deselect")).toHaveLength(1);
    expect(screen.queryByText("1 selection")).toBeNull();
  });
});
