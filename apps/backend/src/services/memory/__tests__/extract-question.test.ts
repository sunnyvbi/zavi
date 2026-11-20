import { describe, it, expect } from "vitest";
import { extractQuestion } from "../write-signal";

describe("extractQuestion (A1 starvation fix)", () => {
  it("keeps the existing chat keys", () => {
    expect(extractQuestion("chat", { user_text: "why did deploy fail?" })).toBe(
      "why did deploy fail?",
    );
    expect(extractQuestion("chat", { intent: "fix the bug" })).toBe("fix the bug");
  });

  it("extracts from non-chat payload keys (the starved population)", () => {
    expect(extractQuestion("cron", { goal: "audit ad spend" })).toBe("audit ad spend");
    expect(extractQuestion("manual", { objective: "draft weekly brief" })).toBe(
      "draft weekly brief",
    );
    expect(extractQuestion("a2a", { task: "reconcile payouts" })).toBe("reconcile payouts");
    expect(extractQuestion("manual", { task_description: "close the loop" })).toBe(
      "close the loop",
    );
    expect(extractQuestion("cron", { message: "check inbox" })).toBe("check inbox");
    expect(extractQuestion("manual", { current_message: "ship it" })).toBe("ship it");
    expect(extractQuestion("a2a", { input: "summarize" })).toBe("summarize");
  });

  it("extracts from nested standing-order / slack / email bodies", () => {
    expect(extractQuestion("manual", { standing_order: { prompt: "always PR" } })).toBe(
      "always PR",
    );
    expect(extractQuestion("slack", { slack: { text: "hey run the report" } })).toBe(
      "hey run the report",
    );
    expect(extractQuestion("email", { email: { body: "please investigate" } })).toBe(
      "please investigate",
    );
  });

  it("prefers the primary chat keys over secondary ones", () => {
    expect(extractQuestion("chat", { user_text: "real ask", goal: "meta" })).toBe("real ask");
  });

  it("returns null for a genuinely empty / questionless payload", () => {
    expect(extractQuestion("cron", {})).toBeNull();
    expect(extractQuestion("cron", { unrelated: 5 })).toBeNull();
    expect(extractQuestion("chat", { user_text: "   " })).toBeNull();
    expect(extractQuestion("manual", null)).toBeNull();
  });

  it("still stringifies an mcp payload (secret-boundary path unchanged)", () => {
    const out = extractQuestion("mcp", { some: "tool", args: { a: 1 } });
    expect(out).toContain("tool");
  });
});
