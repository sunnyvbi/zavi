import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => ({ ok: true })));
vi.mock("@/services/logging/logEvent", () => ({ logEventConfirmed: logEvent }));
const capturePlanStage = vi.hoisted(() => vi.fn());
vi.mock("@/services/analytics/posthog", () => ({ capturePlanStage }));

import {
  __testOnly,
  beginModelAttempt,
  closeToolTiming,
  flushRunTiming,
  noteAssistantMessage,
  markRunTiming,
  noteModelStart,
  noteModelText,
  noteModelTurn,
  noteToolEnd,
  noteToolStart,
  planBuildFields,
  recordRunQueueMs,
} from "../run-timing";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const at = (ms: number) => vi.setSystemTime(T0 + ms);

function simulateRun(runId: string) {
  at(0);
  markRunTiming(runId, "claimed");
  recordRunQueueMs(runId, 800);
  at(3_000);
  beginModelAttempt(runId);
  at(9_000);
  markRunTiming(runId, "sdk_first_text");
  noteModelTurn(runId, "m1");
  noteToolStart(runId, "tu1", "ToolSearch");
  at(9_200);
  expect(noteToolEnd(runId, "tu1")).toBe(200);
  noteModelStart(runId);
  at(15_200);
  noteModelTurn(runId, "m2");
  noteModelTurn(runId, "m2");
  noteToolStart(runId, "tu2", "mcp__server__operator_db__catalog");
  noteToolStart(runId, "tu3", "mcp__server__growth__get_metric");
  at(16_200);
  void closeToolTiming(runId, { tool_use_id: "tu2" });
  at(17_200);
  void closeToolTiming(runId, { tool_use_id: "tu3" });
  at(17_500);
  expect(noteToolEnd(runId, "tu2")).toBe(1_000);
  expect(noteToolEnd(runId, "tu3")).toBe(2_000);
  noteModelStart(runId);
  at(25_500);
  noteModelTurn(runId, "m3");
  markRunTiming(runId, "sdk_result");
  at(27_200);
  markRunTiming(runId, "persisted");
}

beforeEach(() => {
  vi.useFakeTimers();
  logEvent.mockClear();
  capturePlanStage.mockClear();
  __testOnly.ledgers.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("plan build stages in PostHog", () => {
  const firstPlan = planBuildFields({ stage: "draft_strategy", origin: "setup_draft" });

  it("sends each stage of a setup draft as a first plan", async () => {
    simulateRun("plan-a");
    await flushRunTiming("plan-a", { agent_slug: "cgo", outcome: "ok", ...firstPlan }, "tenant-1");
    const stages = capturePlanStage.mock.calls.map((c) => [c[2], c[3]]);
    expect(stages).toEqual([
      ["queue", 800],
      ["prep", 3_000],
      ["model", 20_000],
      ["tools", 3_200],
      ["post_run", 1_700],
      ["run_total", 28_000],
    ]);
    expect(capturePlanStage.mock.calls[0].slice(0, 2)).toEqual(["tenant-1", "plan-a"]);
    expect(capturePlanStage.mock.calls[0][4]).toEqual({ outcome: "ok", first_plan: true });
  });

  it("marks a later redraft as not a first plan, and records how a failed draft ended", async () => {
    simulateRun("plan-b");
    await flushRunTiming("plan-b", { agent_slug: "cgo", outcome: "failed", ...planBuildFields({ stage: "draft_strategy" }) }, "tenant-1");
    expect(capturePlanStage.mock.calls[0][4]).toEqual({ outcome: "failed", first_plan: false });
  });

  it("counts a paid setup draft as a first plan", () => {
    expect(planBuildFields({ stage: "draft_strategy", origin: "setup_draft_paid" })).toEqual({ plan_build: true, first_plan: true });
  });

  it("sends nothing for a cgo run that does not draft a plan", async () => {
    simulateRun("note-run");
    await flushRunTiming("note-run", { agent_slug: "cgo", ...planBuildFields({ stage: "own_goals" }), ...planBuildFields(null) }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(capturePlanStage).not.toHaveBeenCalled();
  });

  it("drops a stage whose time came out negative after an SDK restart", async () => {
    simulateRun("plan-d");
    at(30_000);
    beginModelAttempt("plan-d");
    at(34_000);
    noteModelTurn("plan-d", "n1");
    markRunTiming("plan-d", "sdk_result");
    await flushRunTiming("plan-d", { agent_slug: "cgo", ...firstPlan }, "tenant-1");
    const stages = capturePlanStage.mock.calls.map((c) => c[2]);
    expect(stages).toContain("model");
    expect(stages).not.toContain("post_run");
  });

  it("does not resend the stages when a failed log row is retried", async () => {
    simulateRun("plan-c");
    logEvent.mockResolvedValueOnce({ ok: false });
    await flushRunTiming("plan-c", { agent_slug: "cgo", ...firstPlan }, "tenant-1");
    const sentOnce = capturePlanStage.mock.calls.length;
    await flushRunTiming("plan-c", { agent_slug: "cgo", ...firstPlan }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(capturePlanStage).toHaveBeenCalledTimes(sentOnce);
  });
});

describe("run timing row", () => {
  it("writes one praxis_logs row with stage totals for a cgo run", async () => {
    simulateRun("run-a");
    await flushRunTiming("run-a", { agent_slug: "cgo", trigger: "chat" }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
    const row = logEvent.mock.calls[0][0];
    expect(row).toMatchObject({ level: "info", source: "run_timing", code: "run_timing", tenant_id: "tenant-1", run_id: "run-a" });
    expect(row.meta).toEqual({
      agent_slug: "cgo",
      queue_ms: 800,
      prep_ms: 3_000,
      first_text_ms: 6_000,
      outcome: "ok",
      model_ms: 20_000,
      model_turns: 3,
      tools_ms: 200 + 1_000 + 2_000,
      tool_calls: 3,
      tool_search_calls: 1,
      post_ms: 1_700,
      total_ms: 27_200 + 800,
      tool_ms: "growth__get_metric:1:2000,operator_db__catalog:1:1000,ToolSearch:1:200",
    });
    await flushRunTiming("run-a", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps other agents to the console line", async () => {
    simulateRun("run-b");
    await flushRunTiming("run-b", { agent_slug: "pm" }, "tenant-1");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("writes the row for any agent's run started from Claude, ChatGPT or Codex", async () => {
    simulateRun("run-mcp");
    await flushRunTiming("run-mcp", { agent_slug: "operator", trigger: "mcp" }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toMatchObject({ run_id: "run-mcp", meta: { agent_slug: "operator", queue_ms: 800, model_ms: 20_000 } });
    simulateRun("run-chat");
    await flushRunTiming("run-chat", { agent_slug: "operator", trigger: "chat" }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when this process never saw the model run", async () => {
    at(0);
    markRunTiming("run-c", "claimed");
    markRunTiming("run-c", "persisted");
    await flushRunTiming("run-c", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("keeps the tool list within the stored length, dropping the fastest tools", async () => {
    simulateRun("run-d");
    for (let i = 0; i < 40; i++) {
      noteToolStart("run-d", `x${i}`, `mcp__server__some_server__tool_number_${i}`, T0);
      noteToolEnd("run-d", `x${i}`, T0 + 10 + i);
    }
    await flushRunTiming("run-d", { agent_slug: "cgo" }, "tenant-1");
    const toolMs = (logEvent.mock.calls[0][0].meta as Record<string, unknown>).tool_ms as string;
    expect(toolMs.length).toBeLessThanOrEqual(256);
    expect(toolMs.startsWith("growth__get_metric:1:2000,operator_db__catalog:1:1000")).toBe(true);
    expect(toolMs).not.toContain("tool_number_0:");
  });

  it("returns no time for a tool result whose call it never saw", () => {
    at(0);
    markRunTiming("run-e", "claimed");
    expect(noteToolEnd("run-e", "unknown")).toBeUndefined();
  });

  it("writes nothing for a run whose model produced no turn", async () => {
    at(0);
    markRunTiming("run-f", "claimed");
    markRunTiming("run-f", "sdk_query_start");
    markRunTiming("run-f", "sdk_result");
    markRunTiming("run-f", "persisted");
    await flushRunTiming("run-f", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("records how a failed run ended", async () => {
    simulateRun("run-g");
    await flushRunTiming("run-g", { agent_slug: "cgo", outcome: "failed" }, "tenant-1");
    expect((logEvent.mock.calls[0][0].meta as Record<string, unknown>).outcome).toBe("failed");
  });

  it("retries a failed write once on the next flush, then lets go", async () => {
    simulateRun("run-h");
    logEvent.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false });
    await flushRunTiming("run-h", { agent_slug: "cgo" }, "tenant-1");
    await flushRunTiming("run-h", { agent_slug: "cgo" }, "tenant-1");
    await flushRunTiming("run-h", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(__testOnly.ledgers.has("run-h")).toBe(false);
  });

  it("evicts only the oldest ledger when full, never the run in progress", () => {
    for (let i = 0; i < 2000; i++) markRunTiming(`old-${i}`, "claimed");
    markRunTiming("live", "claimed");
    expect(__testOnly.ledgers.has("old-0")).toBe(false);
    expect(__testOnly.ledgers.has("old-1")).toBe(true);
    expect(__testOnly.ledgers.has("live")).toBe(true);
  });

  it("takes the tool's own duration from the hook, even when the hook beats the call's bookkeeping", async () => {
    simulateRun("run-i");
    await closeToolTiming("run-i", { tool_use_id: "late", tool_name: "mcp__server__memory__search", duration_ms: 420 });
    noteToolStart("run-i", "late", "mcp__server__memory__search");
    expect(noteToolEnd("run-i", "late")).toBe(420);
    await flushRunTiming("run-i", { agent_slug: "cgo" }, "tenant-1");
    const meta = logEvent.mock.calls[0][0].meta as Record<string, unknown>;
    expect(meta.tool_calls).toBe(4);
    expect(meta.tool_ms).toContain("memory__search:1:420");
  });

  it("counts only the attempt that answered when the SDK attempt restarts", async () => {
    simulateRun("run-j");
    at(30_000);
    beginModelAttempt("run-j");
    at(34_000);
    noteModelTurn("run-j", "n1");
    markRunTiming("run-j", "sdk_result");
    at(35_000);
    await flushRunTiming("run-j", { agent_slug: "cgo" }, "tenant-1");
    const meta = logEvent.mock.calls[0][0].meta as Record<string, unknown>;
    expect(meta).toMatchObject({ model_turns: 1, model_ms: 4_000, tool_calls: 0, prep_ms: 30_000 });
  });

  it("files a run whose answer did not parse as parse_failed, and ignores an unknown outcome", async () => {
    simulateRun("run-k");
    await flushRunTiming("run-k", { agent_slug: "cgo", outcome: "parse_failed" }, "tenant-1");
    simulateRun("run-l");
    await flushRunTiming("run-l", { agent_slug: "cgo", outcome: "<script>" }, "tenant-1");
    expect((logEvent.mock.calls[0][0].meta as Record<string, unknown>).outcome).toBe("parse_failed");
    expect((logEvent.mock.calls[1][0].meta as Record<string, unknown>).outcome).toBe("ok");
  });

  it("keeps a run that is still being touched when the map fills", () => {
    markRunTiming("live-early", "claimed");
    for (let i = 0; i < 1999; i++) markRunTiming(`other-${i}`, "claimed");
    markRunTiming("live-early", "sdk_query_start");
    markRunTiming("newcomer", "claimed");
    expect(__testOnly.ledgers.has("live-early")).toBe(true);
    expect(__testOnly.ledgers.has("other-0")).toBe(false);
  });

  it("a tool result keeps its run from being evicted", () => {
    at(0);
    beginModelAttempt("busy");
    noteToolStart("busy", "t1", "x");
    for (let i = 0; i < 1999; i++) markRunTiming(`o-${i}`, "claimed");
    void closeToolTiming("busy", { tool_use_id: "t1", tool_name: "x", duration_ms: 5 });
    markRunTiming("another", "claimed");
    expect(__testOnly.ledgers.has("busy")).toBe(true);
  });

  it("a ledger kept for a retry still respects the cap", async () => {
    simulateRun("retry-me");
    logEvent.mockResolvedValueOnce({ ok: false });
    for (let i = 0; i < 1999; i++) markRunTiming(`f-${i}`, "claimed");
    await flushRunTiming("retry-me", { agent_slug: "cgo" }, "tenant-1");
    markRunTiming("one-more", "claimed");
    expect(__testOnly.ledgers.size).toBeLessThanOrEqual(2000);
    expect(__testOnly.ledgers.has("retry-me")).toBe(true);
  });

  it("an assistant message counts one turn and starts each tool call it makes", async () => {
    at(0);
    markRunTiming("am", "claimed");
    beginModelAttempt("am");
    at(1_000);
    noteAssistantMessage("am", "msg-1", [{ type: "text" }, { type: "tool_use", id: "a", name: "mcp__server__growth__get_metric" }]);
    at(1_300);
    await closeToolTiming("am", { tool_use_id: "a", tool_name: "mcp__server__growth__get_metric" });
    expect(noteToolEnd("am", "a")).toBe(300);
    noteModelStart("am");
    at(2_000);
    noteAssistantMessage("am", "msg-2", [{ type: "text" }]);
    markRunTiming("am", "sdk_result");
    await flushRunTiming("am", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).toMatchObject({ model_turns: 2, model_ms: 1_700, tool_calls: 1, tools_ms: 300 });
  });
});

describe("first model text timing", () => {
  it("records normal assistant text without a synthetic mark or budget warning", async () => {
    at(0); beginModelAttempt("normal-text");
    at(1_200); noteAssistantMessage("normal-text", "m1", [{ type: "text", text: "A useful reply" }]);
    at(2_000); noteAssistantMessage("normal-text", "m2", [{ type: "text", text: "More text" }]);
    markRunTiming("normal-text", "sdk_result");
    await flushRunTiming("normal-text", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).toMatchObject({ first_text_ms: 1_200, first_text_source: "message" });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("A useful reply");
  });

  it("does not count tool requests, thinking or whitespace as text", async () => {
    at(0); beginModelAttempt("no-text");
    at(500); noteAssistantMessage("no-text", "m1", [
      { type: "thinking", text: "hidden" }, { type: "text", text: "  \n " },
      { type: "tool_use", id: "t", name: "ToolSearch" },
    ]);
    at(700); noteToolEnd("no-text", "t");
    markRunTiming("no-text", "sdk_result");
    await flushRunTiming("no-text", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).not.toHaveProperty("first_text_ms");
    expect(logEvent.mock.calls[0][0].meta).not.toHaveProperty("first_text_source");
  });

  it("resets text timing when the SDK attempt is replaced", async () => {
    at(0); beginModelAttempt("retry-text");
    at(500); noteAssistantMessage("retry-text", "m1", [{ type: "text", text: "Abandoned" }]);
    at(4_000); beginModelAttempt("retry-text");
    at(4_800); noteAssistantMessage("retry-text", "m2", [{ type: "text", text: "Accepted" }]);
    markRunTiming("retry-text", "sdk_result");
    await flushRunTiming("retry-text", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).toMatchObject({ first_text_ms: 800, first_text_source: "message" });
  });
});

describe("streamed model text timing", () => {
  it("keeps the first delta when the complete message arrives later", async () => {
    at(0); beginModelAttempt("delta-text");
    at(200); noteModelText("delta-text", " ", "delta");
    at(400); noteModelText("delta-text", "Hello", "delta");
    at(500); noteModelText("delta-text", " again", "delta");
    at(900); noteAssistantMessage("delta-text", "m1", [{ type: "text", text: "Hello again" }]);
    markRunTiming("delta-text", "sdk_result");
    await flushRunTiming("delta-text", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).toMatchObject({ first_text_ms: 400, first_text_source: "delta", model_turns: 1 });
    noteModelText("delta-text", "late callback", "delta");
    expect(__testOnly.ledgers.has("delta-text")).toBe(false);
  });

  it("does not reuse a previous attempt's delta for a textless result", async () => {
    at(0); beginModelAttempt("textless-retry");
    at(300); noteModelText("textless-retry", "discarded", "delta");
    at(1000); beginModelAttempt("textless-retry");
    at(1500); noteAssistantMessage("textless-retry", "m2", [{ type: "tool_use", id: "t", name: "ToolSearch" }]);
    at(1600); noteToolEnd("textless-retry", "t");
    markRunTiming("textless-retry", "sdk_result");
    await flushRunTiming("textless-retry", { agent_slug: "cgo" }, "tenant-1");
    expect(logEvent.mock.calls[0][0].meta).not.toHaveProperty("first_text_ms");
    expect(logEvent.mock.calls[0][0].meta).not.toHaveProperty("first_text_source");
  });
});
