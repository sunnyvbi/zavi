import { describe, it, expect } from "vitest";
import { classifyQuery } from "../query-intent";

describe("classifyQuery", () => {
  it("temporal intent triggers recency=on", () => {
    const c = classifyQuery("what did we discuss last week");
    expect(c.intent).toBe("temporal");
    expect(c.suggestedRecency).not.toBe("off");
  });

  it("'right now' triggers strong recency", () => {
    const c = classifyQuery("what's the status right now");
    expect(c.suggestedRecency).toBe("strong");
  });

  it("entity intent triggers salience=on", () => {
    const c = classifyQuery("who is alice jones");
    expect(c.intent).toBe("entity");
    expect(c.suggestedSalience).not.toBe("off");
  });

  it("'tell me about X' triggers strong salience", () => {
    const c = classifyQuery("tell me about acme");
    expect(c.suggestedSalience).toBe("strong");
  });

  it("event intent → recency=on", () => {
    const c = classifyQuery("when did stripe raise $100M");
    expect(c.intent).toBe("temporal");
    expect(c.suggestedRecency).not.toBe("off");
  });

  it("plain event without temporal cue → event intent + recency=on", () => {
    const c = classifyQuery("acme launched a new product");
    expect(c.intent).toBe("event");
    expect(c.suggestedRecency).toBe("on");
  });

  it("general intent → both axes off", () => {
    const c = classifyQuery("policy for refunds and returns");
    expect(c.intent).toBe("general");
    expect(c.suggestedRecency).toBe("off");
    expect(c.suggestedSalience).toBe("off");
  });

  it("temporal also sets detail=high", () => {
    expect(classifyQuery("what happened yesterday").suggestedDetail).toBe("high");
  });

  it("entity sets detail=low", () => {
    expect(classifyQuery("who is alice").suggestedDetail).toBe("low");
  });

  it("empty query → general all-off", () => {
    expect(classifyQuery("")).toEqual({
      intent: "general",
      suggestedRecency: "off",
      suggestedSalience: "off",
    });
  });

  it("non-string defensive", () => {
    // @ts-expect-error — runtime check
    expect(classifyQuery(null).intent).toBe("general");
  });

  it("'this week' → temporal", () => {
    expect(classifyQuery("did we talk about disputes this week").intent).toBe("temporal");
  });

  it("'dispute' alone → event intent", () => {
    const c = classifyQuery("acme dispute");
    expect(c.intent).toBe("event");
  });

  it("date-shaped 2026-04 → temporal", () => {
    expect(classifyQuery("notes from 2026-04").intent).toBe("temporal");
  });
});
