import { describe, it, expect } from "vitest";
import { parseHumanNumbers, numberAppearsInText } from "../human-number";

describe("parseHumanNumbers", () => {
  it("parses plain numbers with thousands commas", () => {
    expect(parseHumanNumbers("2,660,000 cars")).toEqual([2660000]);
  });

  it("parses abbreviated millions/billions/thousands", () => {
    expect(parseHumanNumbers("2.66M")).toEqual([2660000]);
    expect(parseHumanNumbers("1.2B")).toEqual([1.2e9]);
    expect(parseHumanNumbers("750K")).toEqual([750000]);
  });

  it("parses long-form word suffixes", () => {
    expect(parseHumanNumbers("about 1 billion users")).toEqual([1e9]);
    expect(parseHumanNumbers("205 million in revenue")).toEqual([205e6]);
  });

  it("strips currency symbols without changing magnitude", () => {
    expect(parseHumanNumbers("$1B market")).toEqual([1e9]);
    expect(parseHumanNumbers("$205M ARR")).toEqual([205e6]);
  });

  it("parses percentages at face value", () => {
    expect(parseHumanNumbers("58% female")).toEqual([58]);
    expect(parseHumanNumbers("21.3% MoM")).toEqual([21.3]);
  });

  it("parses both ends of a range", () => {
    expect(parseHumanNumbers("30-55% of users")).toEqual([30, 55]);
  });

  it("returns [] for text with no numbers", () => {
    expect(parseHumanNumbers("no figures here")).toEqual([]);
    expect(parseHumanNumbers("")).toEqual([]);
  });
});

describe("numberAppearsInText", () => {
  it("matches an abbreviated claim against a comma-formatted source (2.66M ↔ 2,660,000)", () => {
    expect(numberAppearsInText(2_660_000, "the fleet has 2,660,000 vehicles")).toBe(true);
  });

  it("matches $1B claim against '1 billion' source text", () => {
    expect(numberAppearsInText(1e9, "valued at roughly 1 billion dollars")).toBe(true);
  });

  it("matches a percentage within tolerance", () => {
    expect(numberAppearsInText(58, "57.9% of respondents")).toBe(true);
  });

  it("does NOT match a genuinely different number", () => {
    expect(numberAppearsInText(58, "only 42% agreed")).toBe(false);
    expect(numberAppearsInText(1e9, "a $205M round")).toBe(false);
  });

  it("returns false when the source has no numbers at all", () => {
    expect(numberAppearsInText(58, "qualitative feedback only")).toBe(false);
  });

  it("matches exact zero only against a literal zero", () => {
    expect(numberAppearsInText(0, "0 incidents reported")).toBe(true);
    expect(numberAppearsInText(0, "5 incidents reported")).toBe(false);
  });
});
