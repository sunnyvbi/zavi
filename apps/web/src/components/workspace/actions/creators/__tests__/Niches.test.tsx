// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Niches } from "../CreatorCard";
import type { CreatorCardData } from "../types";

const CHIP = 50;
const MORE = 30;
const ROOM = 200;
const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const realClient = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.tagName !== "SPAN") return 0;
      return this.textContent?.startsWith("+") ? MORE : CHIP;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => ROOM });
});

afterEach(() => {
  cleanup();
  if (realOffset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", realOffset);
  if (realClient) Object.defineProperty(Element.prototype, "clientWidth", realClient);
});

const gapPx = (el: Element) => {
  const m = el.className.match(/(?:^|\s)gap-(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!m) throw new Error(`no gap class on ${el.className}`);
  return Number(m[1]) * 4;
};

describe("Niches fit", () => {
  it("measures with the same gap the row and ruler render, so the +N chip is never clipped", () => {
    const c = { niches: ["alpha", "bravo", "charlie", "delta"] } as CreatorCardData;
    const { container } = render(<Niches c={c} />);
    const row = container.firstElementChild as HTMLElement;
    const ruler = row.querySelector('[aria-hidden="true"]') as HTMLElement;
    const gap = gapPx(row);
    expect(gapPx(ruler)).toBe(gap);
    expect(gap).toBe(8);
    const visible = Array.from(row.children).filter((el) => el !== ruler) as HTMLElement[];
    const width = visible.reduce((sum, el) => sum + el.offsetWidth, 0) + gap * (visible.length - 1);
    expect(width).toBeLessThanOrEqual(ROOM);
    expect(visible.map((el) => el.textContent)).toEqual(["Alpha", "Bravo", "+2"]);
  });
});
