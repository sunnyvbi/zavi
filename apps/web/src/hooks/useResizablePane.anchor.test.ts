
import { describe, it, expect } from "vitest";
import { paneSizeFromPointer, growKeyFor } from "@/hooks/useResizablePane";

const BOUNDS = { left: 0, right: 1200 };

describe("paneSizeFromPointer", () => {
  it("right-anchored: width is the distance from the RIGHT edge", () => {
    expect(paneSizeFromPointer("right", BOUNDS, 800)).toBe(400);
    expect(paneSizeFromPointer("right", BOUNDS, 700)).toBe(500);
  });

  it("left-anchored: width is the distance from the LEFT edge", () => {
    expect(paneSizeFromPointer("left", BOUNDS, 400)).toBe(400);
    expect(paneSizeFromPointer("left", BOUNDS, 500)).toBe(500);
  });

  it("the two anchors are mirror images about the container's midpoint", () => {
    for (const x of [0, 240, 600, 999, 1200]) {
      const l = paneSizeFromPointer("left", BOUNDS, x);
      const r = paneSizeFromPointer("right", BOUNDS, x);
      expect(l + r).toBe(BOUNDS.right - BOUNDS.left);
    }
  });

  it("honours a container that does not start at x=0", () => {
    const inset = { left: 300, right: 1500 };
    expect(paneSizeFromPointer("left", inset, 700)).toBe(400);
    expect(paneSizeFromPointer("right", inset, 700)).toBe(800);
  });
});

describe("growKeyFor", () => {
  it("widens with ArrowLeft when right-anchored (unchanged for every old caller)", () => {
    expect(growKeyFor("right")).toBe("ArrowLeft");
  });

  it("widens with ArrowRight when left-anchored", () => {
    expect(growKeyFor("left")).toBe("ArrowRight");
  });

  it("never returns the same key for both anchors", () => {
    expect(growKeyFor("left")).not.toBe(growKeyFor("right"));
  });
});
