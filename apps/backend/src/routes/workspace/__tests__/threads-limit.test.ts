import { describe, expect, it } from "vitest";
import { parseThreadLimit } from "../threads";

describe("parseThreadLimit", () => {
  it("defaults to 50 when the caller says nothing", () => {
    expect(parseThreadLimit(undefined)).toBe(50);
    expect(parseThreadLimit("")).toBe(50);
  });

  it("caps at 200 so one query can't ask for the whole table", () => {
    expect(parseThreadLimit("200")).toBe(200);
    expect(parseThreadLimit("5000")).toBe(200);
  });

  it("falls back rather than trusting junk, a float, or a non-positive count", () => {
    expect(parseThreadLimit(["3"])).toBe(50);
    expect(parseThreadLimit("abc")).toBe(50);
    expect(parseThreadLimit("2.5")).toBe(50);
    expect(parseThreadLimit("0")).toBe(50);
    expect(parseThreadLimit("-3")).toBe(50);
  });

  it("passes a sane explicit count through", () => {
    expect(parseThreadLimit("10")).toBe(10);
  });
});
