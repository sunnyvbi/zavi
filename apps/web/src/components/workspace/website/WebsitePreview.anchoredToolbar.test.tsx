// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview, anchorEditToolbar } from "./WebsitePreview";

vi.mock("./SiteElementDesignControls", () => ({
  isSitePhoto: (selected: { tag: string; attrs?: { src?: string } }) => selected.tag === "img" && /^\/images\//.test(selected.attrs?.src ?? ""),
  SiteElementDesignControls: ({ selected }: { selected: { section?: string; tag: string } }) => (
    <div aria-label="Instant design controls">
      {selected.section && <button type="button">Move section up</button>}
      {selected.tag === "img" && <input aria-label="Describe replacement photo" />}
    </div>
  ),
}));

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

const APP_URL = "https://my-shop.zaviagent.com";
const SELECTOR = "main > h1";

describe("anchorEditToolbar", () => {
  const frame = { w: 1000, h: 700 };
  const toolbar = { w: 400, h: 44 };

  it("puts the toolbar just under the element and the tag just above it", () => {
    const out = anchorEditToolbar({ rect: { x: 100, y: 200, w: 300, h: 50 }, scale: 1, frame, toolbar })!;
    expect(out.toolbar).toEqual({ left: 100, top: 258 });
    expect(out.chip).toEqual({ left: 100, top: 172 });
  });

  it("flips above the element when there is no room below", () => {
    const out = anchorEditToolbar({ rect: { x: 100, y: 620, w: 300, h: 60 }, scale: 1, frame, toolbar })!;
    expect(out.toolbar.top).toBe(620 - 24 - 44 - 8);
  });

  it("keeps the toolbar inside the frame on the right and the left", () => {
    expect(anchorEditToolbar({ rect: { x: 900, y: 100, w: 80, h: 20 }, scale: 1, frame, toolbar })!.toolbar.left).toBe(1000 - 400 - 8);
    expect(anchorEditToolbar({ rect: { x: -40, y: 100, w: 80, h: 20 }, scale: 1, frame, toolbar })!.toolbar.left).toBe(8);
  });

  it("scales the page's coordinates into the frame and tucks the tag inside when the element touches the top", () => {
    const out = anchorEditToolbar({ rect: { x: 200, y: 0, w: 400, h: 100 }, scale: 0.5, frame, toolbar })!;
    expect(out.toolbar).toEqual({ left: 100, top: 58 });
    expect(out.chip.top).toBe(4);
  });

  it("gives up anchoring when the element is scrolled fully out of the frame", () => {
    expect(anchorEditToolbar({ rect: { x: 10, y: -300, w: 200, h: 100 }, scale: 1, frame, toolbar })).toBeNull();
    expect(anchorEditToolbar({ rect: { x: 10, y: 720, w: 200, h: 100 }, scale: 1, frame, toolbar })).toBeNull();
  });

  it("an element taller than the frame keeps the toolbar on screen", () => {
    const out = anchorEditToolbar({ rect: { x: 10, y: 5, w: 900, h: 2000 }, scale: 1, frame, toolbar })!;
    expect(out.toolbar.top).toBeGreaterThanOrEqual(8);
    expect(out.toolbar.top + toolbar.h).toBeLessThanOrEqual(frame.h - 8);
  });
});

describe("the element toolbar follows the selected element", () => {
  let observers: Array<() => void> = [];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
          observers.push(cb);
        }
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const toolbarWrap = this.className.includes("inline-flex") && this.querySelector('[data-testid="editor-toolbar"]');
      const size = toolbarWrap ? { width: 400, height: 44 } : { width: 1000, height: 700 };
      return { ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => size } as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mount(appId = "my-shop.zaviagent.com") {
    const view = render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={appId} builtApp editPlacement="dock" />);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    const posted: Array<{ type?: string; selectors?: string[] }> = [];
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (m: { type?: string }) => posted.push(m) } });
    const send = (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
      });
    send({ type: "zavi:editor-ready" });
    act(() => observers.forEach((cb) => cb()));
    return { posted, send };
  }

  const rects = (x: number, y: number, w: number, h: number) => ({ type: "zavi:editor-rects", rects: [{ selector: SELECTOR, found: true, x, y, w, h }], vw: 1000, vh: 700 });

  it("asks the page where the element is, then draws the tag above it and the toolbar under it", () => {
    const app = mount();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
    app.send({ type: "zavi:editor-selected", selector: SELECTOR, tag: "h1", text: "Self-drive cars", style: {} });
    expect(app.posted).toContainEqual({ type: "zavi:editor-rects-request", selectors: [SELECTOR] });
    expect(screen.queryByTestId("edit-toolbar-anchor")).toBeNull();

    app.send(rects(100, 200, 300, 50));
    const anchor = screen.getByTestId("edit-toolbar-anchor");
    expect(anchor.style.left).toBe("100px");
    expect(anchor.style.top).toBe("258px");
    expect(within(anchor).getByTestId("editor-toolbar")).toBeTruthy();
    const tag = screen.getByTestId("edit-selection-tag");
    expect(tag.textContent).toBe("h1");
    expect(tag.style.top).toBe("172px");
    expect(screen.getAllByTestId("editor-toolbar")).toHaveLength(1);

    app.send(rects(100, 620, 300, 60));
    expect(screen.getByTestId("edit-toolbar-anchor").style.top).toBe(`${620 - 24 - 44 - 8}px`);

    app.send({ type: "zavi:editor-rects", rects: [{ selector: SELECTOR, found: false }], vw: 1000, vh: 700 });
    expect(screen.getByTestId("edit-toolbar-anchor").style.top).toBe(`${620 - 24 - 44 - 8}px`);

    app.send(rects(100, -400, 300, 60));
    expect(screen.queryByTestId("edit-toolbar-anchor")).toBeNull();
    expect(screen.getAllByTestId("editor-toolbar")).toHaveLength(1);
  });

  it("keeps an AI draft when dragging the anchored toolbar", () => {
    const app = mount();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
    app.send({ type: "zavi:editor-selected", selector: SELECTOR, tag: "h1", text: "Self-drive cars", style: {} });
    app.send(rects(100, 200, 300, 50));
    fireEvent.click(screen.getByTestId("editor-toolbar-mode"));
    const draft = screen.getByRole("textbox", {name:"Ask AI to change this element"});
    fireEvent.change(draft, { target: { value: "Make this headline shorter" } });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Drag toolbar" }), {clientX: 100, clientY: 100});
    fireEvent.pointerMove(window, {clientX: 140, clientY: 140});
    const moved = screen.getByTestId("editor-toolbar").parentElement!.parentElement!;
    expect(moved.style.left).toBe("40px");
    expect(moved.style.top).toBe("40px");
    fireEvent.pointerUp(window);
    expect(screen.getByRole("textbox", {name:"Ask AI to change this element"}).getAttribute("value")).toBe("Make this headline shorter");
  });

  it("keeps section and photo design options reachable without an extra toolbar row", () => {
    const app = mount("site:11111111-1111-4111-8111-111111111111");
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
    app.send({ type: "zavi:editor-selected", selector: SELECTOR, tag: "h1", text: "x", section: "hero", style: {} });
    expect(screen.queryByLabelText("Instant design controls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Design options" }));
    expect(screen.getByRole("button", { name: "Move section up" })).toBeTruthy();
    app.send({ type: "zavi:editor-selected", selector: "main img", tag: "img", text: "", attrs: { src: "/images/hero.jpg" }, style: {} });
    expect(screen.queryByLabelText("Instant design controls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Design options" }));
    expect(screen.getByRole("textbox", { name: "Describe replacement photo" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Describe replacement photo" }), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Design options" }));
    expect(screen.queryByRole("textbox", { name: "Describe replacement photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Design options" }));
    expect((screen.getByRole("textbox", { name: "Describe replacement photo" }) as HTMLInputElement).value).toBe("Keep this draft");
  });

  it("a new selection never borrows the previous element's box", () => {
    const app = mount();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
    app.send({ type: "zavi:editor-selected", selector: SELECTOR, tag: "h1", text: "x", style: {} });
    app.send(rects(100, 200, 300, 50));
    expect(screen.getByTestId("edit-selection-tag").textContent).toBe("h1");
    app.send({ type: "zavi:editor-selected", selector: "main > p", tag: "p", text: "y", style: {} });
    expect(screen.queryByTestId("edit-toolbar-anchor")).toBeNull();
    expect(screen.queryByTestId("edit-selection-tag")).toBeNull();
    app.send({ type: "zavi:editor-rects", rects: [{ selector: "main > p", found: true, x: 50, y: 400, w: 200, h: 30 }], vw: 1000, vh: 700 });
    expect(screen.getByTestId("edit-selection-tag").textContent).toBe("p");
    expect(screen.getByTestId("edit-toolbar-anchor").style.top).toBe("438px");
  });

  it("ignores rects for other elements and stops watching once the selection is cleared", () => {
    const app = mount();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: /^Edit/ }));
    app.send({ type: "zavi:editor-selected", selector: SELECTOR, tag: "h1", text: "x", style: {} });
    app.send({ type: "zavi:editor-rects", rects: [{ selector: "footer", found: true, x: 1, y: 1, w: 1, h: 1 }], vw: 1000, vh: 700 });
    expect(screen.queryByTestId("edit-toolbar-anchor")).toBeNull();
    app.send(rects(100, 200, 300, 50));
    expect(screen.getByTestId("edit-toolbar-anchor")).toBeTruthy();
    const before = app.posted.length;
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("edit-toolbar-anchor")).toBeNull();
    expect(screen.queryByTestId("edit-selection-tag")).toBeNull();
    expect(app.posted.slice(before)).toContainEqual({ type: "zavi:editor-rects-request", selectors: [] });
  });
});
