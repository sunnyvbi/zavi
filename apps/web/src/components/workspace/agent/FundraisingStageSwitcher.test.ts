import { describe, it, expect } from "vitest";
import { roundWithArticle } from "./FundraisingStageSwitcher";

describe("roundWithArticle", () => {
  it.each([
    ["Angel", "an Angel round"],
    ["Pre-seed", "a Pre-seed round"],
    ["Seed", "a Seed round"],
    ["Series A", "a Series A round"],
    ["Series B+", "a Series B+ round"],
  ] as const)("%s -> %s", (stage, want) => {
    expect(roundWithArticle(stage)).toBe(want);
  });
});
