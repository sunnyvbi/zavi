// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

import { ASK_AI_NOT_APPLIED, WebsitePreview } from "./WebsitePreview";

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

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

const APP_URL = "https://northline.zaviagent.com";
const APP_ID = "northline.zaviagent.com";
const RUNS = ["A quieter way to rent a car. ", "Northline opens the road soon."];
const NEW_RUNS = ["Rent a car, quietly. ", "Northline is almost here."];
const PRIOR = { patch: { style: { fontWeight: "bold" } }, removed: false };
const VERSION = { id: "edit-1", updated_at: "version-1" };

type Msg = Record<string, unknown>;

function mount(opts: { dock?: boolean } = {}) {
  const view = render(
    <WebsitePreview
      liveUrl={APP_URL}
      cacheKey={null}
      appId={APP_ID}
      builtApp
      editPlacement={opts.dock ? "dock" : "header"}
    />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Msg[] = [];
  const onPost = { fn: (_m: Msg) => {} };
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: {
      postMessage: (m: Msg) => {
        posted.push(m);
        onPost.fn(m);
      },
    },
  });
  const fromApp = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow }));
    });
  return { posted, fromApp, onPost };
}

function routeApi(handlers: Record<string, (body: Msg) => { status?: number; json: unknown }>) {
  apiFetch.mockImplementation(async (path: string, init?: { body?: string }) => {
    const key = path.split("?")[0];
    const h = handlers[key];
    const out = h ? h(init?.body ? JSON.parse(init.body) : {}) : { json: {} };
    const status = out.status ?? 200;
    return { ok: status < 400, status, json: async () => out.json };
  });
}
const callsTo = (path: string) =>
  apiFetch.mock.calls.filter(([p]) => p === path).map(([, i]) => JSON.parse((i as { body: string }).body));

async function selectHero(fromApp: (d: unknown) => void, protocol?: number) {
  fromApp(protocol ? { type: "zavi:editor-ready", protocol } : { type: "zavi:editor-ready" });
  fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
  fromApp({
    type: "zavi:editor-selected",
    selector: "main > h1",
    tag: "H1",
    text: "",
    textEditable: false,
    segments: RUNS,
    style: {},
    ...(protocol ? { protocol } : {}),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Element" }));
  return screen.findByRole("textbox", { name: "Ask AI to change this element" });
}

async function ask(input: HTMLElement, message = "polish it further") {
  fireEvent.change(input, { target: { value: message } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Ask AI waits for the runtime to confirm the change landed", () => {
  it("a runtime that says the runs no longer fit shows an error and restores the earlier draft instead of leaving the phantom one", async () => {
    routeApi({
      "/api/website/resolve-edit": () => ({ json: { patch: { segments: NEW_RUNS }, prior: PRIOR, version: VERSION } }),
    });
    const { fromApp, onPost, posted } = mount();
    onPost.fn = (m) => {
      if (m.type === "zavi:editor-apply" && m.ack) {
        queueMicrotask(() => fromApp({ type: "zavi:editor-applied", selector: m.selector, ok: false, protocol: 2 }));
      }
    };
    await ask(await selectHero(fromApp, 2));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ASK_AI_NOT_APPLIED);
    expect(callsTo("/api/website/resolve-edit")[0]).toMatchObject({ segments: RUNS, sparse: true });
    expect(posted.find((m) => m.type === "zavi:editor-apply")).toMatchObject({ ack: true, reveal: false });
    await waitFor(() => expect(callsTo("/api/website/discard")).toHaveLength(1));
    expect(callsTo("/api/website/discard")[0]).toEqual({ app_id: APP_ID, selector: "main > h1", restore: PRIOR, expected: VERSION });
  });

  it("an element with no earlier draft is discarded outright when the runtime says not applied", async () => {
    routeApi({
      "/api/website/resolve-edit": () => ({
        json: { patch: { segments: NEW_RUNS }, prior: null, version: VERSION },
      }),
    });
    const { fromApp, onPost } = mount();
    onPost.fn = (m) => {
      if (m.type === "zavi:editor-apply" && m.ack) {
        queueMicrotask(() => fromApp({ type: "zavi:editor-applied", selector: m.selector, ok: false }));
      }
    };
    await ask(await selectHero(fromApp, 2));
    await screen.findByRole("alert");
    await waitFor(() => expect(callsTo("/api/website/discard")).toEqual([{
      app_id: APP_ID,
      selector: "main > h1",
      expected: VERSION,
    }]));
  });

  it("an ack for a different element does not settle this one", async () => {
    routeApi({ "/api/website/resolve-edit": () => ({ json: { patch: { segments: NEW_RUNS }, prior: PRIOR, version: VERSION } }) });
    const { fromApp, onPost } = mount();
    onPost.fn = (m) => {
      if (m.type === "zavi:editor-apply" && m.ack) {
        queueMicrotask(() => {
          fromApp({ type: "zavi:editor-applied", selector: "footer p", ok: true });
          fromApp({ type: "zavi:editor-applied", selector: m.selector, ok: false });
        });
      }
    };
    await ask(await selectHero(fromApp, 2));
    expect((await screen.findByRole("alert")).textContent).toBe(ASK_AI_NOT_APPLIED);
  });

  it("a confirmed apply shows no error and discards nothing", async () => {
    routeApi({ "/api/website/resolve-edit": () => ({ json: { patch: { segments: NEW_RUNS }, prior: PRIOR, version: VERSION } }) });
    const { fromApp, onPost, posted } = mount();
    onPost.fn = (m) => {
      if (m.type === "zavi:editor-apply" && m.ack) {
        queueMicrotask(() => fromApp({ type: "zavi:editor-applied", selector: m.selector, ok: true, protocol: 2 }));
      }
    };
    const input = await selectHero(fromApp, 2);
    await ask(input);
    await waitFor(() => expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(true));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo("/api/website/discard")).toHaveLength(0);
  });

  it("a runtime that says it confirms but never answers is treated as not applied", async () => {
    routeApi({ "/api/website/resolve-edit": () => ({ json: { patch: { segments: NEW_RUNS }, prior: PRIOR, version: VERSION } }) });
    const { fromApp } = mount();
    await ask(await selectHero(fromApp, 2));
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toBe(ASK_AI_NOT_APPLIED);
    expect(callsTo("/api/website/discard")[0]).toMatchObject({ restore: PRIOR });
  }, 8000);

  it("an older runtime with no ack keeps today's behaviour: applied without waiting, no sparse runs asked for, nothing discarded", async () => {
    routeApi({ "/api/website/resolve-edit": () => ({ json: { patch: { segments: NEW_RUNS } } }) });
    const { fromApp, posted } = mount();
    const input = await selectHero(fromApp);
    await ask(input);
    await waitFor(() => expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(true));
    const apply = posted.find((m) => m.type === "zavi:editor-apply")!;
    expect(apply).not.toHaveProperty("ack");
    expect(apply).toMatchObject({ patch: { segments: NEW_RUNS }, reveal: false });
    expect(callsTo("/api/website/resolve-edit")[0]).not.toHaveProperty("sparse");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo("/api/website/discard")).toHaveLength(0);
  });
});

describe("annotation strokes belong to one preview width", () => {
  function draw(points: Array<[number, number]>) {
    const canvas = screen.getByTestId("annotation-canvas");
    const [first, ...rest] = points;
    fireEvent.pointerDown(canvas, { clientX: first![0], clientY: first![1], button: 0, pointerId: 1 });
    for (const [x, y] of rest) fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  }

  it("switching the device clears strokes drawn over the old layout, including undo history", () => {
    routeApi({});
    mount({ dock: true });
    fireEvent.load(document.querySelector("iframe")!);
    const tools = screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(tools).getByRole("button", { name: "Annotate" }));
    draw([[10, 10], [40, 30]]);
    draw([[60, 60], [90, 90]]);
    expect(screen.getByTestId("annotation-canvas").querySelectorAll("path")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText(/^Preview width/));
    expect(screen.getByTestId("annotation-canvas").querySelectorAll("path")).toHaveLength(0);
    expect((within(tools).getByRole("button", { name: "Undo stroke" }) as HTMLButtonElement).disabled).toBe(true);
    draw([[5, 5], [30, 30]]);
    expect(screen.getByTestId("annotation-canvas").querySelectorAll("path")).toHaveLength(1);
  });
});

describe("route menu explains its greyed routes", () => {
  it("a disabled dynamic route points at visible helper text, and no tooltip or title is used", () => {
    routeApi({});
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-routes", routes: ["/", "/cars", "/cars/:id"] });
    fireEvent.click(screen.getByRole("button", { name: "Go to a route" }));
    const dynamic = screen.getByRole("menuitem", { name: /\/cars\/:id/ }) as HTMLButtonElement;
    expect(dynamic.disabled).toBe(true);
    const hintId = dynamic.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId!)!;
    expect(hint.textContent).toMatch(/Type the full path above/);
    expect(dynamic.hasAttribute("title")).toBe(false);
    expect(screen.getByRole("menuitem", { name: /^\/cars$/ }).getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("no helper text when nothing is greyed", () => {
    routeApi({});
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-routes", routes: ["/", "/cars"] });
    fireEvent.click(screen.getByRole("button", { name: "Go to a route" }));
    expect(screen.queryByText(/Type the full path above/)).toBeNull();
  });
});
