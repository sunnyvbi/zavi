
import { describe, it, expect } from "vitest";
import { detectRecallIntent, RECALL_PROMPT_RULE } from "../recall-intent";

describe("detectRecallIntent", () => {
  it("fires on past-task phrasings", () => {
    for (const t of [
      "what were the params on that report last week?",
      "can you find the PR you opened yesterday",
      "remember when we ran the churn analysis?",
      "the other day you built a dashboard, what was in it",
      "3 days ago you sent something to the customer",
      "what was the settings on that last run",
      "the report from last month",
    ]) {
      expect(detectRecallIntent(t), t).toBe(true);
    }
  });

  it("does NOT fire on ordinary current requests", () => {
    for (const t of [
      "can you pull today's ad spend",
      "draft a reply to this customer",
      "what's our MER right now",
      "hi",
      "",
    ]) {
      expect(detectRecallIntent(t), t).toBe(false);
    }
  });

  it("handles non-strings safely", () => {
    expect(detectRecallIntent(undefined as never)).toBe(false);
    expect(detectRecallIntent(null as never)).toBe(false);
  });

  it("prompt rule warns against inventing params", () => {
    expect(RECALL_PROMPT_RULE).toMatch(/do NOT invent/i);
    expect(RECALL_PROMPT_RULE).toMatch(/praxis_corpus__query_recent_runs/);
  });
});
