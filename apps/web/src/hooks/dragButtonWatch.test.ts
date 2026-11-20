import { describe, expect, it } from "vitest";

import { createDragButtonWatch } from "./dragButtonWatch";

describe("createDragButtonWatch", () => {
  it("keeps the drag alive while the primary button is held", () => {
    const held = createDragButtonWatch();
    expect(held(1)).toBe(true);
    expect(held(1)).toBe(true);
    expect(held(3)).toBe(true);
  });

  it("ends the drag on the first move after the button is released", () => {
    const held = createDragButtonWatch();
    held(1);
    expect(held(0)).toBe(false);
  });

  it("stays ended once the button has been released", () => {
    const held = createDragButtonWatch();
    held(1);
    held(0);
    expect(held(0)).toBe(false);
  });

  it("does not end a drag whose moves never report a held button", () => {
    const held = createDragButtonWatch();
    expect(held(0)).toBe(true);
    expect(held(0)).toBe(true);
  });

  it("ignores a secondary button as evidence the drag is held", () => {
    const held = createDragButtonWatch();
    expect(held(2)).toBe(true);
    expect(held(0)).toBe(true);
  });

  it("tracks each drag independently", () => {
    const first = createDragButtonWatch();
    first(1);
    expect(first(0)).toBe(false);
    const second = createDragButtonWatch();
    expect(second(0)).toBe(true);
  });
});
