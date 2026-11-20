
import { describe, it, expect } from "vitest";
import { pairToolResultToTrace } from "@/services/agents/generic-dispatcher";
import type { ToolCallTrace } from "@/services/tools/types";

function row(
  name: string,
  tool_use_id?: string,
  output_preview = "",
): ToolCallTrace {
  return {
    name,
    input_preview: `{"for":"${name}"}`,
    output_preview,
    ms: 0,
    status: "ok",
    ...(tool_use_id ? { tool_use_id } : {}),
  };
}

describe("pairToolResultToTrace — by-id pairing (parallel tool calls)", () => {
  it("pairs each out-of-order result to ITS OWN row by tool_use_id (the prod growth-lead shuffle)", () => {
    const ledger = [
      row("mcp__growth__diagnose_funnel", "toolu_01"),
      row("mcp__growth__read_cohort", "toolu_02"),
      row("mcp__growth__content_punchlist", "toolu_03"),
    ];
    const r3 = pairToolResultToTrace(ledger, "toolu_03");
    expect(r3?.name).toBe("mcp__growth__content_punchlist");
    r3!.output_preview = '{"punchlist":[…]}';

    const r1 = pairToolResultToTrace(ledger, "toolu_01");
    expect(r1?.name).toBe("mcp__growth__diagnose_funnel");
    r1!.output_preview = '{"funnel":{…}}';

    const r2 = pairToolResultToTrace(ledger, "toolu_02");
    expect(r2?.name).toBe("mcp__growth__read_cohort");
  });

  it("attributes an is_error result to the erroring tool, not the last-issued one", () => {
    const ledger = [
      row("memory__search", "toolu_a"),
      row("product__probe", "toolu_b"),
    ];
    const errTrace = pairToolResultToTrace(ledger, "toolu_b");
    expect(errTrace?.name).toBe("product__probe");
  });

  it("falls back to last-unfilled when the result block has no tool_use_id", () => {
    const ledger = [
      row("tool_one", "toolu_x", '{"done":true}'),
      row("tool_two", "toolu_y"),
    ];
    const trace = pairToolResultToTrace(ledger, undefined);
    expect(trace?.name).toBe("tool_two");
  });

  it("falls back to last-unfilled when trace rows were pushed without ids (legacy rows)", () => {
    const ledger = [row("legacy_one"), row("legacy_two")];
    const trace = pairToolResultToTrace(ledger, "toolu_unmatched");
    expect(trace?.name).toBe("legacy_two");
  });

  it("re-resolves a duplicate result for the same id to the SAME row (never corrupts a neighbor)", () => {
    const ledger = [
      row("tool_one", "toolu_1", '{"first":true}'),
      row("tool_two", "toolu_2"),
    ];
    const trace = pairToolResultToTrace(ledger, "toolu_1");
    expect(trace?.name).toBe("tool_one");
  });

  it("returns undefined when nothing matches and every row is filled", () => {
    const ledger = [row("tool_one", "toolu_1", "{}")];
    expect(pairToolResultToTrace(ledger, "toolu_other")).toBeUndefined();
    expect(pairToolResultToTrace([], "toolu_any")).toBeUndefined();
  });
});
