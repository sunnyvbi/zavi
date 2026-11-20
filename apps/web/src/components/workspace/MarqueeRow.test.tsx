// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarqueeRow } from "./MarqueeRow";

const VIEWPORT_W = 320;
const COPY_W = 900;

function fakeGeometry() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return VIEWPORT_W;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return COPY_W;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return this.previousElementSibling ? COPY_W + 8 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return COPY_W * 2;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, right: VIEWPORT_W, top: 0, bottom: 40, width: VIEWPORT_W, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

function pointer(
  target: Element,
  type: string,
  init: { pointerId?: number; pointerType?: string; clientX: number; clientY?: number },
) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY ?? 10 });
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 7 });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch" });
  act(() => {
    target.dispatchEvent(ev);
  });
}

describe("MarqueeRow on a touch screen", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onChip: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fakeGeometry();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    onChip = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <MarqueeRow>
          {["Stripe", "GitHub", "Meta Ads", "Search Console"].map((label) => (
            <button key={label} type="button" onClick={onChip}>
              {label}
            </button>
          ))}
        </MarqueeRow>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function parts() {
    const viewport = host.firstElementChild as HTMLDivElement;
    const track = viewport.firstElementChild as HTMLDivElement;
    return { viewport, track };
  }

  it("pans the strip when a thumb drags it sideways", () => {
    const { viewport, track } = parts();
    expect(viewport.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);

    pointer(viewport, "pointerdown", { clientX: 200 });
    pointer(viewport, "pointermove", { clientX: 160 });
    pointer(viewport, "pointermove", { clientX: 120 });

    expect(track.style.transform).toBe("translate3d(-80px,0,0)");
    expect(viewport.className).toContain("touch-pan-y");
  });

  it("keeps a plain tap on a chip working", () => {
    const { viewport } = parts();
    const chip = viewport.querySelector("button") as HTMLButtonElement;

    pointer(chip, "pointerdown", { clientX: 200 });
    pointer(chip, "pointermove", { clientX: 201 });
    pointer(chip, "pointerup", { clientX: 201 });
    act(() => {
      chip.click();
    });

    expect(onChip).toHaveBeenCalledTimes(1);
  });

  it("does not fire the chip the thumb happens to lift from after a drag", () => {
    const { viewport } = parts();
    const chip = viewport.querySelector("button") as HTMLButtonElement;

    pointer(chip, "pointerdown", { clientX: 200 });
    pointer(chip, "pointermove", { clientX: 150 });
    pointer(chip, "pointerup", { clientX: 150 });
    act(() => {
      chip.click();
    });

    expect(onChip).not.toHaveBeenCalled();
  });
});
