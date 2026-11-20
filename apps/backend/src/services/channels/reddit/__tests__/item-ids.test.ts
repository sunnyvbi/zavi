import { describe, expect, it } from "vitest";
import { stripItemIds } from "../item-ids";

describe("stripItemIds", () => {
  it("replaces a leading thread id with plain words", () => {
    expect(
      stripItemIds("Seen in 1 thread in r/uktravel this week. t3 explicitly weighs Turo against conventional rental agencies."),
    ).toBe("Seen in 1 thread in r/uktravel this week. A thread explicitly weighs Turo against conventional rental agencies.");
  });

  it("handles lists, comments, possessives and parentheses", () => {
    expect(stripItemIds("Buyers in t3 and t8 compare prices.")).toBe("Buyers in these threads compare prices.");
    expect(stripItemIds("c2 asks for a cheaper option.")).toBe("A comment asks for a cheaper option.");
    expect(stripItemIds("t4's author was banned.")).toBe("A thread's author was banned.");
    expect(stripItemIds("Hosts complain about fees (t1, t2).")).toBe("Hosts complain about fees.");
    expect(stripItemIds("As item t5 shows, insurance matters.")).toBe("As a thread shows, insurance matters.");
  });

  it("leaves ordinary text and empty values alone", () => {
    expect(stripItemIds("Owners in T3 cities want delivery; the 2014 model is fine.")).toBe(
      "Owners in T3 cities want delivery; the 2014 model is fine.",
    );
    expect(stripItemIds(null)).toBeNull();
    expect(stripItemIds("")).toBe("");
  });
});
