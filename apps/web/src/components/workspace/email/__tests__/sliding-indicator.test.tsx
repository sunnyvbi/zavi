// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SlidingIndicator, useActiveBox } from "../SlidingIndicator";

let left = 0;
const proto = HTMLElement.prototype;
const saved = {
  w: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
  h: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
  l: Object.getOwnPropertyDescriptor(proto, "offsetLeft"),
  t: Object.getOwnPropertyDescriptor(proto, "offsetTop"),
};

beforeEach(() => {
  left = 10;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 40 });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 20 });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get: () => left });
  Object.defineProperty(proto, "offsetTop", { configurable: true, get: () => 0 });
});

afterEach(() => {
  cleanup();
  for (const [k, d] of [["offsetWidth", saved.w], ["offsetHeight", saved.h], ["offsetLeft", saved.l], ["offsetTop", saved.t]] as const) {
    if (d) Object.defineProperty(proto, k, d);
  }
});

function Tabs({ shown }: { shown: boolean }) {
  const [box, ref] = useActiveBox<HTMLDivElement>('[aria-pressed="true"]', "same-key");
  if (!shown) return null;
  return (
    <div ref={ref} className="relative flex">
      <SlidingIndicator box={box} kind="pill" />
      <button aria-pressed="true">All</button>
    </div>
  );
}

describe("useActiveBox", () => {
  it("measures the tab group again when it remounts under the same key", () => {
    const { rerender } = render(<Tabs shown />);
    expect(screen.getByTestId("sliding-indicator-pill").style.transform).toBe("translate(10px, 0px)");
    rerender(<Tabs shown={false} />);
    left = 70;
    rerender(<Tabs shown />);
    expect(screen.getByTestId("sliding-indicator-pill").style.transform).toBe("translate(70px, 0px)");
  });
});
