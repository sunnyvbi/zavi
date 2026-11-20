// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: unknown }>,
  answer: null as null | ((url: string, body: unknown) => { status: number; body: unknown }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    api.calls.push({ url, body });
    const a = api.answer!(url, body);
    return { ok: a.status < 400, status: a.status, json: async () => a.body } as Response;
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

import { ANNOTATION_COLOR, AnnotationCanvas } from "./PreviewAnnotation";
import { MASK_BRUSH, maskDataUrl, painterSize } from "./PhotoMaskPainter";
import { SiteElementDesignControls } from "./SiteElementDesignControls";
import { loadSiteDesignEdit } from "@/lib/workspace/siteDesignEdit";
import type { SelectedElement } from "./editorProtocol";

type Recorded = { width: number; height: number; ops: Array<[string, ...unknown[]]>; lineWidth?: unknown; strokeStyle?: unknown };

const canvas = vi.hoisted(() => ({ made: [] as Recorded[], urls: [] as string[] }));

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

const realGetContext = HTMLCanvasElement.prototype.getContext;
const realToDataURL = HTMLCanvasElement.prototype.toDataURL;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const rec: Recorded = { width: this.width, height: this.height, ops: [] };
    canvas.made.push(rec);
    const op =
      (name: string) =>
      (...args: unknown[]) =>
        rec.ops.push([name, ...args]);
    return new Proxy(
      {},
      {
        get: (_t, key: string) => (key === "lineWidth" ? rec.lineWidth : key === "strokeStyle" ? rec.strokeStyle : op(key)),
        set: (_t, key: string, value) => {
          if (key === "lineWidth") rec.lineWidth = value;
          if (key === "strokeStyle") rec.strokeStyle = value;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = function () {
    return canvas.urls.shift() ?? "data:image/png;base64,QUJD";
  };
  api.calls = [];
  canvas.made = [];
  canvas.urls = [];
});
afterEach(() => {
  cleanup();
  HTMLCanvasElement.prototype.getContext = realGetContext;
  HTMLCanvasElement.prototype.toDataURL = realToDataURL;
});

const APP = "site:aaaaaaaa-0000-4000-8000-000000000001";
const photoEl: SelectedElement = { selector: "main img", tag: "img", text: "", textEditable: true, style: {}, attrs: { src: "/images/hero-1600.webp" }, section: "hero" };
const PHOTO = { data_url: "data:image/webp;base64,UklGRg==", width: 1600, height: 900 };

function state(over: Record<string, unknown> = {}) {
  return { theme: null, fonts: [], radii: [], section: null, section_message: null, image_ai: true, image_ai_mask: true, ...over };
}

function brush(points: Array<[number, number]>) {
  const c = screen.getByTestId("annotation-canvas");
  const [first, ...rest] = points;
  fireEvent.pointerDown(c, { clientX: first![0], clientY: first![1], button: 0, pointerId: 1 });
  for (const [x, y] of rest) fireEvent.pointerMove(c, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(c, { pointerId: 1 });
}

const posts = () => api.calls.filter((c) => c.body);

describe("AnnotationCanvas brush option", () => {
  it("draws the thin red pen by default and a wide soft brush when asked", () => {
    const { container, rerender } = render(<AnnotationCanvas strokes={[[{ x: 1, y: 1 }]]} onStroke={() => {}} />);
    const g = () => container.querySelector("g")!;
    expect(g().getAttribute("stroke")).toBe(ANNOTATION_COLOR);
    expect(g().getAttribute("stroke-width")).toBe("3");
    expect(g().hasAttribute("stroke-opacity")).toBe(false);
    rerender(<AnnotationCanvas strokes={[[{ x: 1, y: 1 }]]} onStroke={() => {}} strokeWidth={28} strokeOpacity={0.5} color="#fff" />);
    expect(g().getAttribute("stroke-width")).toBe("28");
    expect(g().getAttribute("stroke-opacity")).toBe("0.5");
    expect(g().getAttribute("stroke")).toBe("#fff");
  });
});

describe("maskDataUrl", () => {
  const display = painterSize({ width: 1600, height: 900 });

  it("paints the strokes white at the photo's natural size, scaled from the painter", () => {
    expect(display).toEqual({ width: 300, height: 169 });
    const url = maskDataUrl([[{ x: 10, y: 10 }, { x: 50, y: 20 }, { x: 90, y: 40 }]], display, { width: 1600, height: 900 });
    expect(url).toBe("data:image/png;base64,QUJD");
    expect(canvas.made).toHaveLength(1);
    const rec = canvas.made[0]!;
    expect([rec.width, rec.height]).toEqual([1600, 900]);
    expect(rec.ops.find((o) => o[0] === "scale")).toEqual(["scale", 1600 / 300, 900 / 169]);
    expect(rec.strokeStyle).toBe("#ffffff");
    expect(rec.lineWidth).toBe(MASK_BRUSH);
    expect(rec.ops.filter((o) => o[0] === "stroke")).toHaveLength(1);
    expect(rec.ops.find((o) => o[0] === "moveTo")).toEqual(["moveTo", 10, 10]);
  });

  it("drops to a smaller mask when the full one is too big to send, and gives up past a quarter", () => {
    const big = `data:image/png;base64,${"A".repeat(4000)}`;
    canvas.urls = [big, "data:image/png;base64,QUJD"];
    expect(maskDataUrl([[{ x: 1, y: 1 }]], display, { width: 1600, height: 900 }, MASK_BRUSH, 1000)).toBe("data:image/png;base64,QUJD");
    expect(canvas.made.map((r) => [r.width, r.height])).toEqual([
      [1600, 900],
      [800, 450],
    ]);
    canvas.made = [];
    canvas.urls = [big, big, big];
    expect(maskDataUrl([[{ x: 1, y: 1 }]], display, { width: 1600, height: 900 }, MASK_BRUSH, 1000)).toBeNull();
    expect(canvas.made).toHaveLength(3);
    expect(maskDataUrl([], display, { width: 1600, height: 900 })).toBeNull();
  });
});

describe("Change part of this photo", () => {
  it("brushes an area, sends the mask with the instruction, and closes once saved", async () => {
    api.answer = (url) => {
      if (url.includes("photo=")) return { status: 200, body: { photo: PHOTO } };
      if (url.startsWith("/api/website/site-design-edit?")) return { status: 200, body: state() };
      return { status: 200, body: { ok: true, image: { src: "/images/hero-2-1600.webp", srcset: "", places: 1 } } };
    };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change part of this photo" }));
    const img = (await screen.findByAltText("The photo to change")) as HTMLImageElement;
    expect(img.src).toBe(PHOTO.data_url);
    expect(api.calls[1]!.url).toContain(`photo=${encodeURIComponent("/images/hero-1600.webp")}`);
    const apply = screen.getByRole("button", { name: "Change this part" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    brush([
      [20, 20],
      [60, 30],
    ]);
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Describe the photo"), { target: { value: "  put a red  umbrella here " } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await screen.findByText(/goes live when you publish/);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      app_id: APP,
      path: "/",
      op: { kind: "image", src: "/images/hero-1600.webp", mode: "edit", text: "put a red umbrella here", mask: "data:image/png;base64,QUJD" },
    });
    expect(canvas.made.map((r) => [r.width, r.height])).toEqual([[1600, 900]]);
    expect(screen.queryByAltText("The photo to change")).toBeNull();
  });

  it("keeps the brush open with the server's reason, and sends nothing when the photo can't load", async () => {
    api.answer = (url) => {
      if (url.includes("photo=")) return { status: 200, body: { photo: PHOTO } };
      if (url.startsWith("/api/website/site-design-edit?")) return { status: 200, body: state() };
      return { status: 422, body: { error: { code: "mask_empty", message: "Brush over the part of the photo to change first. Nothing was run or charged." } } };
    };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change part of this photo" }));
    await screen.findByAltText("The photo to change");
    brush([[5, 5]]);
    fireEvent.change(screen.getByLabelText("Describe the photo"), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Change this part" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Brush over the part");
    expect(screen.getByAltText("The photo to change")).toBeTruthy();
    cleanup();

    api.calls = [];
    api.answer = (url) => {
      if (url.includes("photo=")) return { status: 422, body: { error: { code: "image_missing", message: "This photo can't be swapped here." } } };
      return { status: 200, body: state() };
    };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change part of this photo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("can't be swapped here");
    expect(screen.queryByAltText("The photo to change")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("hides the brush when the mask switch is off, and never trusts it without AI photos", async () => {
    api.answer = () => ({ status: 200, body: state({ image_ai_mask: false }) });
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    await screen.findByRole("button", { name: "Change this photo" });
    expect(screen.queryByRole("button", { name: "Change part of this photo" })).toBeNull();
    api.answer = () => ({ status: 200, body: state({ image_ai: false, image_ai_mask: true }) });
    const r = await loadSiteDesignEdit(APP);
    expect(r.ok && r.state.image_ai_mask).toBe(false);
  });

  it("cancelling the brush sends nothing", async () => {
    api.answer = (url) => (url.includes("photo=") ? { status: 200, body: { photo: PHOTO } } : { status: 200, body: state() });
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change part of this photo" }));
    await screen.findByAltText("The photo to change");
    brush([[5, 5]]);
    fireEvent.click(screen.getByRole("button", { name: "Stop changing part of the photo" }));
    await waitFor(() => expect(screen.queryByAltText("The photo to change")).toBeNull());
    expect(posts()).toHaveLength(0);
  });
});
