// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useResizablePane } from "./useResizablePane";

const STORAGE_KEY = "zavi.releaseTestWidth";

const options = {
  storageKey: STORAGE_KEY,
  min: 340,
  maxFraction: 0.9,
  round: "max" as const,
  defaultPx: 420,
  resetTo: 420,
};

function mousedown() {
  return {
    preventDefault() {},
    clientX: 1000,
    button: 0,
  } as unknown as React.MouseEvent;
}

function move(clientX: number, buttons: number) {
  act(() => {
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX, buttons, bubbles: true }),
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("a drag whose mouseup never reaches the window", () => {
  it("stops following the pointer once the button is no longer held", () => {
    const { result } = renderHook(() => useResizablePane(options));

    act(() => result.current.startResize(mousedown()));
    move(900, 1);
    const atRelease = result.current.sizePx;
    expect(atRelease).toBe(700);

    move(600, 0);
    expect(result.current.sizePx).toBe(atRelease);

    move(400, 0);
    expect(result.current.sizePx).toBe(atRelease);
  });

  it("persists the width it had when the button was released", () => {
    const { result } = renderHook(() => useResizablePane(options));

    act(() => result.current.startResize(mousedown()));
    move(900, 1);
    move(600, 0);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("700");
  });

  it("a later drag starts clean rather than ending on its first move", () => {
    const { result } = renderHook(() => useResizablePane(options));

    act(() => result.current.startResize(mousedown()));
    move(900, 1);
    move(600, 0);

    act(() => result.current.startResize(mousedown()));
    move(800, 1);
    expect(result.current.sizePx).toBe(800);
  });
});
