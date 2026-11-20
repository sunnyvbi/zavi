// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";
import { EMPTY_ANNOTATIONS, annotationReducer, strokePath, type AnnotationState } from "./PreviewAnnotation";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

beforeAll(() => {
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = PointerEventPolyfill;
  }
});

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
  fireEvent.load(frame);
  const ready = () =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "zavi:editor-ready" }, origin: APP_URL, source: frame.contentWindow }),
      );
    });
  return { view, frame, posted, ready };
}

function tools() {
  return screen.getByRole("toolbar", { name: "Preview tools" });
}

function draw(points: Array<[number, number]>) {
  const canvas = screen.getByTestId("annotation-canvas");
  const [first, ...rest] = points;
  fireEvent.pointerDown(canvas, { clientX: first![0], clientY: first![1], button: 0, pointerId: 1 });
  for (const [x, y] of rest) fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

const paths = () => Array.from(screen.getByTestId("annotation-canvas").querySelectorAll("path"));

describe("annotationReducer", () => {
  const stroke = (n: number) => [{ x: n, y: n }];
  const run = (...actions: Parameters<typeof annotationReducer>[1][]) =>
    actions.reduce<AnnotationState>(annotationReducer, EMPTY_ANNOTATIONS);

  it("undoes a Clear, bringing every stroke back", () => {
    const s = run({ type: "add", stroke: stroke(1) }, { type: "add", stroke: stroke(2) }, { type: "clear" }, { type: "undo" });
    expect(s.strokes).toEqual([stroke(1), stroke(2)]);
  });

  it("drops the redo stack once a new stroke is drawn", () => {
    const s = run({ type: "add", stroke: stroke(1) }, { type: "undo" }, { type: "add", stroke: stroke(3) }, { type: "redo" });
    expect(s.strokes).toEqual([stroke(3)]);
    expect(s.future).toEqual([]);
  });

  it("walks back and forward through history in order", () => {
    const s = run(
      { type: "add", stroke: stroke(1) },
      { type: "add", stroke: stroke(2) },
      { type: "undo" },
      { type: "undo" },
      { type: "redo" },
    );
    expect(s.strokes).toEqual([stroke(1)]);
    expect(s.past).toEqual([[]]);
    expect(s.future).toEqual([[stroke(1), stroke(2)]]);
  });

  it("treats undo with no history, redo with no future and clear on nothing as no-ops", () => {
    expect(run({ type: "undo" })).toBe(EMPTY_ANNOTATIONS);
    expect(run({ type: "redo" })).toBe(EMPTY_ANNOTATIONS);
    expect(run({ type: "clear" })).toBe(EMPTY_ANNOTATIONS);
    expect(run({ type: "add", stroke: [] })).toBe(EMPTY_ANNOTATIONS);
  });

  it("draws a lone tap as a visible dot, not an empty path", () => {
    expect(strokePath([{ x: 4, y: 5 }])).toBe("M 4 5 l 0.01 0");
    expect(strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }])).toBe("M 0 0 Q 10 0 15 5 L 20 10");
  });
});

describe("annotating the preview", () => {
  it("draws strokes over the page and undoes, redoes and clears them from the bar", () => {
    mount();
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    expect(within(tools()).getByText("Annotation")).toBeTruthy();
    const clear = within(tools()).getByRole("button", { name: "Clear" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);

    draw([[10, 10], [40, 30], [80, 60]]);
    draw([[100, 100], [140, 120]]);
    expect(paths()).toHaveLength(2);
    expect(paths()[0]!.getAttribute("d")).toBe("M 10 10 Q 40 30 60 45 L 80 60");
    expect(clear.disabled).toBe(false);

    fireEvent.click(within(tools()).getByRole("button", { name: "Undo stroke" }));
    expect(paths()).toHaveLength(1);
    fireEvent.click(within(tools()).getByRole("button", { name: "Redo stroke" }));
    expect(paths()).toHaveLength(2);

    fireEvent.click(clear);
    expect(paths()).toHaveLength(0);
    fireEvent.click(within(tools()).getByRole("button", { name: "Undo stroke" }));
    expect(paths()).toHaveLength(2);
  });

  it("hides the drawing when annotation closes and brings it back on reopen", () => {
    mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    draw([[1, 1], [20, 20]]);
    fireEvent.click(within(tools()).getByRole("button", { name: "Close annotation" }));
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    expect(within(tools()).getByRole("button", { name: "Annotate" })).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    expect(paths()).toHaveLength(1);
  });

  it("wipes the drawing when the page reloads, because it no longer lines up", () => {
    mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    draw([[1, 1], [20, 20]]);
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    fireEvent.load(document.querySelector("iframe")!);
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    expect(paths()).toHaveLength(0);
  });

  it("takes Cmd+Z and Escape for itself, but never from a text field", () => {
    mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    draw([[1, 1], [20, 20]]);
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    fireEvent.keyDown(box, { key: "z", metaKey: true });
    expect(paths()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(paths()).toHaveLength(0);
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(paths()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    box.remove();
  });

  it("hides Annotate while editing, and brings it back once editing stops", () => {
    const app = mount();
    app.ready();
    expect(within(tools()).getByRole("button", { name: "Annotate" })).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    expect(within(tools()).getByRole("button", { name: /^Editing/ })).toBeTruthy();
    expect(within(tools()).queryByRole("button", { name: "Annotate" })).toBeNull();
    fireEvent.click(within(tools()).getByRole("button", { name: "Exit edit mode" }));
    expect(within(tools()).getByRole("button", { name: "Annotate" })).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    expect(screen.getByTestId("annotation-canvas")).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: "Stop annotating" }));
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit/ }));
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    expect(app.posted.filter((m) => m.type === "zavi:editor-mode").pop()?.enabled).toBe(true);
  });
});

describe("turning edit mode on", () => {
  it.each(["header", "dock"] as const)("does not resize the framed page (%s)", (placement) => {
    const app = mount(placement);
    app.ready();
    const box = app.frame.parentElement!;
    const before = { className: box.className, style: box.getAttribute("style"), iframe: app.frame.getAttribute("style") };
    const ring = screen.getByTestId("edit-frame-ring");
    expect(ring.className).toContain("opacity-0");

    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    expect(screen.getByRole("button", { name: /^Editing/ }).getAttribute("aria-pressed")).toBe("true");

    expect(box.className).toBe(before.className);
    expect(box.getAttribute("style")).toBe(before.style);
    expect(app.frame.getAttribute("style")).toBe(before.iframe);
    expect(ring.className).toContain("opacity-100");
    expect(ring.className).toContain("pointer-events-none");
  });

  it.each(["header", "dock"] as const)("morphs the same Edit control into Editing instead of swapping it (%s)", (placement) => {
    const app = mount(placement);
    app.ready();
    const button = screen.getByRole("button", { name: /^Edit/ });
    const exit = screen.getByTestId("edit-exit");
    expect(exit.getAttribute("aria-hidden")).toBe("true");
    expect(exit.className).toContain("max-w-0");
    expect(screen.queryByRole("button", { name: "Exit edit mode" })).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole("button", { name: /^Editing/ })).toBe(button);
    expect(screen.getByTestId("edit-exit")).toBe(exit);
    expect(exit.getAttribute("aria-hidden")).toBe("false");
    expect(exit.className).toContain("transition-[max-width,opacity]");

    fireEvent.click(screen.getByRole("button", { name: "Exit edit mode" }));
    expect(screen.getByRole("button", { name: /^Edit$/ })).toBe(button);
  });
});
