// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TAB_SWAP_KEYFRAMES, TAB_SWAP_TIMING, useTabSwap } from "./useTabSwap";

function Panel({ tab }: { tab: string }) {
  const ref = useTabSwap<HTMLDivElement>(tab);
  return <div ref={ref} data-testid="panel">{tab}</div>;
}

const animate = vi.fn();

function stubMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
}

afterEach(() => {
  cleanup();
  animate.mockReset();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe("useTabSwap", () => {
  it("does not animate the first paint, animates each switch once, and not a re-render on the same tab", () => {
    stubMotion(false);
    const view = render(<Panel tab="all" />);
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<Panel tab="images" />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(TAB_SWAP_KEYFRAMES, TAB_SWAP_TIMING);
    expect(animate.mock.instances[0]).toBe(view.getByTestId("panel"));
    view.rerender(<Panel tab="images" />);
    expect(animate).toHaveBeenCalledTimes(1);
    view.rerender(<Panel tab="videos" />);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("stays still for a reader who asked for reduced motion", () => {
    stubMotion(true);
    const view = render(<Panel tab="all" />);
    view.rerender(<Panel tab="images" />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("matches the CSS tab-swap animation the analytics tabs use", async () => {
    const config = (await import("../../../tailwind.config")).default as { theme: { extend: { keyframes: Record<string, Record<string, Record<string, string>>>; animation: Record<string, string> } } };
    const css = config.theme.extend.keyframes["tab-swap"];
    expect(css["0%"]).toEqual({ opacity: "0", transform: String(TAB_SWAP_KEYFRAMES[0].transform) });
    expect(config.theme.extend.animation["tab-swap"]).toContain(`${TAB_SWAP_TIMING.duration}ms ${TAB_SWAP_TIMING.easing}`);
  });
});
