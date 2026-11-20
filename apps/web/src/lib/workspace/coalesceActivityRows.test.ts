import { describe, it, expect } from "vitest";
import { coalesceActivityRows } from "./coalesceActivityRows";
import type { ChatRow } from "./useChatThread";

function row(
  id: string,
  body: Record<string, unknown>,
): ChatRow {
  return {
    id,
    kind: "chat_activity",
    agent_run_id: "run-1",
    body,
    citations: [],
    created_at: "2026-06-13T00:00:00Z",
  } as ChatRow;
}
const tool = (id: string, tool_name: string, target = "") =>
  row(id, { teKind: "tool_call", tool_name, target });
const reasoning = (id: string, text: string) =>
  row(id, { teKind: "reasoning", text });

describe("coalesceActivityRows", () => {
  it("collapses a burst of adjacent same-tool calls into one ×N group", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      tool(`t${i}`, "web_search__search", i === 0 ? '{"query":"seed VCs"}' : ""),
    );
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(11);
    expect(out[0].key).toBe("t0");
  });

  it("a blank call is absorbed into its detailed neighbour, showing the real query", () => {
    const rows = [
      tool("a", "web_search__search", ""),
      tool("b", "web_search__search", '{"query":"refund policy"}'),
      tool("c", "web_search__search", ""),
    ];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].key).toBe("a");
    expect(out[0].row.id).toBe("b");
  });

  it("NEVER merges two different real queries — that would misreport N calls as one", () => {
    const rows = [
      tool("a", "web_search__search", '{"query":"refund policy"}'),
      tool("b", "web_search__search", '{"query":"insurance coverage"}'),
      tool("c", "web_search__search", '{"query":"payout schedule"}'),
    ];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(3);
    expect(out.every((g) => g.count === 1)).toBe(true);
  });

  it("blank rows bridge to the LEFT neighbour, not across two different queries", () => {
    const rows = [
      tool("a", "web_search__search", '{"query":"refund policy"}'),
      tool("b", "web_search__search", ""),
      tool("c", "web_search__search", '{"query":"insurance coverage"}'),
    ];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(2);
    expect(out[0].count).toBe(2);
    expect(out[1].row.id).toBe("c");
  });

  it("collapses N identical adjacent calls into one ×N", () => {
    const rows = [tool("a", "investor_discovery__search"), tool("b", "investor_discovery__search"), tool("c", "investor_discovery__search")];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].row.id).toBe("a");
  });

  it("never merges across non-tool rows (reasoning interleave breaks the run)", () => {
    const rows = [
      tool("a", "web_search__search"),
      reasoning("r", "thinking"),
      tool("b", "web_search__search"),
    ];
    const out = coalesceActivityRows(rows);
    expect(out.map((g) => [g.row.id, g.count])).toEqual([
      ["a", 1],
      ["r", 1],
      ["b", 1],
    ]);
  });

  it("does not merge different tools even when adjacent", () => {
    const rows = [tool("a", "web_search__search"), tool("b", "memory__search")];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(2);
  });

  it("reasoning / file / plan rows always stand alone (count 1)", () => {
    const rows = [reasoning("r1", "a"), reasoning("r2", "b")];
    const out = coalesceActivityRows(rows);
    expect(out).toHaveLength(2);
    expect(out.every((g) => g.count === 1)).toBe(true);
  });

  it("empty input → empty output", () => {
    expect(coalesceActivityRows([])).toEqual([]);
  });
});
