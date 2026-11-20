import { describe, it, expect } from "vitest";
import { founderAdviceView } from "../hold-view";

describe("founderAdviceView", () => {
  it("passes the worker's 'unavailable' mark through, so the card can say its warnings are missing", () => {
    expect(founderAdviceView({ warnings: [], at: "x", unavailable: true })).toEqual({ warnings: [], unavailable: true });
  });
  it("must-not-touch: real warnings are served as before, and a junk mark is ignored", () => {
    expect(founderAdviceView({ warnings: ["it is still settling", 7], at: "x" })).toEqual({ warnings: ["it is still settling"] });
    expect(founderAdviceView({ warnings: [], unavailable: "yes" })).toEqual({ warnings: [] });
    expect(founderAdviceView(null)).toBeNull();
  });
});
