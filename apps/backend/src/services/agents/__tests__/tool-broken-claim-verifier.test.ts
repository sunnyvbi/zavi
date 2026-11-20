import { describe, it, expect } from "vitest";
import { verifyToolBrokenClaim } from "../claim-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

const call = (name: string, status: string): ToolCallTrace =>
  ({ name, status } as unknown as ToolCallTrace);

const INCIDENT_REPLY =
  "The query tool hits an error every time it tries to run an aggregate against your DB — " +
  "this has been happening consistently across multiple runs. The root cause (filed as SCRUM-5412) " +
  "is a parameter serialization bug: when the tool passes parameters like dates or filter values " +
  "into the query, they arrive as the wrong type (strings instead of proper types), so the database " +
  "rejects the operation before it can execute. Until engineering fixes that (SCRUM-5412), every " +
  "aggregate I try to run from here fails with the same error.";

describe("verifyToolBrokenClaim — ungrounded broken-tool claims", () => {
  it("flags the exact f45ac090 reply when the run made zero tool calls", () => {
    const r = verifyToolBrokenClaim({ reply: INCIDENT_REPLY, toolCalls: [] });
    expect(r.flagged).toBe(true);
    expect(r.text).toContain("Unverified tool-failure claim");
    expect(r.text).toContain(INCIDENT_REPLY);
    expect(r.flags.matched_patterns.length).toBeGreaterThan(0);
  });

  it("flags when the run only made SUCCESSFUL tool calls (catalog-then-claim)", () => {
    const r = verifyToolBrokenClaim({
      reply: "The DB query tool is still broken (SCRUM-5412), so I filed the pipeline for engineering.",
      toolCalls: [call("mcp__server__operator_db__catalog", "ok")],
    });
    expect(r.flagged).toBe(true);
  });

  it.each([
    ["tool-is-broken", "The DB query tool is still broken, use the workaround."],
    ["tool-hits-error", "The query tool keeps hitting the same failure on aggregates."],
    ["serialization-blocks", "The serialization bug (SCRUM-5412) blocked the live pull again."],
    ["every-call-fails", "Every parameter comes through as a string, so nothing executes."],
    ["ticket-blocking", "SCRUM-5412 is still blocking the query tool."],
  ])("catches the %s phrasing", (_label, reply) => {
    expect(verifyToolBrokenClaim({ reply, toolCalls: [] }).flagged).toBe(true);
  });

  it("a memory__ tool failure does NOT ground a live broken-tool claim", () => {
    const r = verifyToolBrokenClaim({
      reply: "The query tool is broken — every aggregate fails.",
      toolCalls: [call("memory__search", "tool_error")],
    });
    expect(r.flagged).toBe(true);
  });
});

describe("verifyToolBrokenClaim — grounded / exempt cases", () => {
  it("a failed non-memory tool call THIS run grounds the claim (no banner)", () => {
    const r = verifyToolBrokenClaim({
      reply: "The query tool hits an error on this aggregate — here is the raw error I got.",
      toolCalls: [
        call("mcp__server__operator_db__catalog", "ok"),
        call("mcp__server__operator_db__query", "tool_error"),
      ],
    });
    expect(r.flagged).toBe(false);
    expect(r.flags.failed_tool_in_trace).toBe(true);
  });

  it("prior-turn-marked honest claims are exempt", () => {
    const r = verifyToolBrokenClaim({
      reply:
        "Earlier in this thread the query tool was failing on aggregates; I haven't rechecked it this run.",
      toolCalls: [],
    });
    expect(r.flagged).toBe(false);
    expect(r.flags.prior_turn_marked).toBe(true);
  });

  it("resolution framing is not a brokenness claim", () => {
    const r = verifyToolBrokenClaim({
      reply: "Good news: the serialization bug that blocked aggregates has been fixed — queries work now.",
      toolCalls: [],
    });
    expect(r.flagged).toBe(false);
  });

  it("ordinary prose about data does not trip it", () => {
    const r = verifyToolBrokenClaim({
      reply:
        "Subscription trips May–Jul 2026: May 2 trips / 61 days, Jun 5 / 151, Jul 24 / 744. Pulled live from trips.",
      toolCalls: [call("mcp__server__operator_db__query", "ok")],
    });
    expect(r.flagged).toBe(false);
    expect(r.flags.matched_patterns).toEqual([]);
  });

  it("empty reply is a no-op", () => {
    const r = verifyToolBrokenClaim({ reply: "", toolCalls: [] });
    expect(r.flagged).toBe(false);
    expect(r.text).toBe("");
  });
});
