import { describe, it, expect } from "vitest";
import { pickNarratorLine } from "./narratorLine";
import type { ChatRow } from "./useChatThread";

function row(id: string, body: Record<string, unknown>): ChatRow {
  return {
    id,
    kind: "chat_activity",
    agent_run_id: "run-1",
    body,
    citations: [],
    created_at: "2026-07-17T00:00:00Z",
  } as ChatRow;
}
const tool = (id: string, tool_name: string, target = "") =>
  row(id, { teKind: "tool_call", tool_name, target });
const reasoning = (id: string, text: string) =>
  row(id, { teKind: "reasoning", text });

const describe_ = (r: ChatRow) => {
  const b = r.body as Record<string, unknown>;
  return {
    label: b.tool_name === "web_search__search" ? "Search" : "Tool",
    detail: String(b.target ?? "").replace(/[{}"]/g, ""),
  };
};

describe("pickNarratorLine", () => {
  it("prefers the agent's LATEST sentence over any tool row", () => {
    const out = pickNarratorLine(
      [
        reasoning("r1", "Pulling the saved policy docs first."),
        tool("t1", "web_search__search", "refund policy"),
        reasoning("r2", "Good, the docs cover refunds. Now checking coverage."),
        tool("t2", "web_search__search", "coverage"),
      ],
      describe_,
    );
    expect(out).toEqual({
      kind: "prose",
      text: "Good, the docs cover refunds. Now checking coverage.",
    });
  });

  it("falls back to a tool verb when no prose exists yet", () => {
    const out = pickNarratorLine(
      [tool("t1", "web_search__search", "insurance coverage")],
      describe_,
    );
    expect(out).toEqual({
      kind: "verb",
      label: "Search",
      detail: "insurance coverage",
    });
  });

  it("skips empty reasoning text rather than showing a blank line", () => {
    const out = pickNarratorLine(
      [reasoning("r1", "   "), tool("t1", "web_search__search", "q")],
      describe_,
    );
    expect(out?.kind).toBe("verb");
  });

  it("no activity → null (caller shows generic 'is working' copy)", () => {
    expect(pickNarratorLine([], describe_)).toBeNull();
  });

  it("clamps a long sentence at a word boundary, never mid-word", () => {
    const long =
      "I am checking the saved policy documents and the live product data " +
      "so that every number in this answer is grounded in something real " +
      "rather than something I merely remember from earlier in the thread.";
    const out = pickNarratorLine([reasoning("r1", long)], describe_);
    const text = out?.kind === "prose" ? out.text : "";
    expect(text.length).toBeLessThanOrEqual(181);
    expect(text.endsWith("…")).toBe(true);
    expect(text.slice(0, -1)).toBe(text.slice(0, -1).trimEnd());
    expect(long.startsWith(text.slice(0, -1))).toBe(true);
  });

  it("collapses newlines so multi-line reasoning stays one clean line", () => {
    const out = pickNarratorLine(
      [reasoning("r1", "Checking the docs.\n\nThen the coverage rules.")],
      describe_,
    );
    expect(out).toEqual({
      kind: "prose",
      text: "Checking the docs. Then the coverage rules.",
    });
  });

  it("ignores plan rows when falling back (the plan renders as its own block)", () => {
    const out = pickNarratorLine(
      [row("p1", { teKind: "plan", summary: "Ship the fix", steps: ["a"] })],
      describe_,
    );
    expect(out).toBeNull();
  });
});
