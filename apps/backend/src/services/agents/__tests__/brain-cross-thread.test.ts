
import { describe, it, expect } from "vitest";
import { extractCrossThreadHits } from "../brain-cross-thread";
import type { ToolCallTrace } from "@/services/tools/types";

function mkSearchCall(
  hits: Array<Record<string, unknown>>,
  overrides: Partial<ToolCallTrace> = {},
): ToolCallTrace {
  return {
    name: "memory_search",
    input_preview: "{}",
    output_preview: JSON.stringify({ hits }),
    ms: 12,
    status: "ok",
    ...overrides,
  };
}

describe("extractCrossThreadHits (qa-blind-fixes 2026-05-26 Commit C)", () => {
  it("returns [] when tool_calls is null/undefined/empty", () => {
    expect(extractCrossThreadHits(null, "T1")).toEqual([]);
    expect(extractCrossThreadHits(undefined, "T1")).toEqual([]);
    expect(extractCrossThreadHits([], "T1")).toEqual([]);
  });

  it("returns [] when no memory_search calls present", () => {
    const tc: ToolCallTrace = {
      name: "slack_list_channels",
      input_preview: "{}",
      output_preview: '{"hits":[{"thread_id":"T2"}]}',
      ms: 1,
      status: "ok",
    };
    expect(extractCrossThreadHits([tc], "T1")).toEqual([]);
  });

  it("filters out same-thread hits (the tag is 'across THREADS')", () => {
    const call = mkSearchCall([
      { thread_id: "T1", title: "a" },
      { thread_id: "T1", title: "b" },
    ]);
    expect(extractCrossThreadHits([call], "T1")).toEqual([]);
  });

  it("returns unique cross-thread thread_ids", () => {
    const call = mkSearchCall([
      { thread_id: "T2", title: "a" },
      { thread_id: "T3", title: "b" },
      { thread_id: "T2", title: "c" },
      { thread_id: "T1", title: "d" },
    ]);
    const out = extractCrossThreadHits([call], "T1").sort();
    expect(out).toEqual(["T2", "T3"]);
  });

  it("treats null/missing thread_id as no-tag (does not throw)", () => {
    const call = mkSearchCall([
      { title: "a" },
      { thread_id: null, title: "b" },
      { thread_id: "", title: "c" },
      { thread_id: 42, title: "d" },
    ]);
    expect(extractCrossThreadHits([call], "T1")).toEqual([]);
  });

  it("skips errored memory_search calls", () => {
    const call = mkSearchCall([{ thread_id: "T2" }], { status: "tool_error" });
    expect(extractCrossThreadHits([call], "T1")).toEqual([]);
  });

  it("survives malformed/truncated JSON in output_preview (no throw)", () => {
    const truncated: ToolCallTrace = {
      name: "memory_search",
      input_preview: "{}",
      output_preview: '{"hits":[{"thread_id":"T2"}, {"thr',
      ms: 1,
      status: "ok",
    };
    expect(extractCrossThreadHits([truncated], "T1")).toEqual([]);
  });

  it("accepts both memory_search and memory__search name shapes", () => {
    const a = mkSearchCall([{ thread_id: "T2" }], { name: "memory_search" });
    const b = mkSearchCall([{ thread_id: "T3" }], { name: "memory__search" });
    const out = extractCrossThreadHits([a, b], "T1").sort();
    expect(out).toEqual(["T2", "T3"]);
  });

  it("when current_thread_id is null (non-chat run), every hit thread_id is returned", () => {
    const call = mkSearchCall([
      { thread_id: "T2" },
      { thread_id: "T3" },
    ]);
    const out = extractCrossThreadHits([call], null).sort();
    expect(out).toEqual(["T2", "T3"]);
  });

  it("aggregates across multiple memory_search calls in the same run", () => {
    const a = mkSearchCall([{ thread_id: "T2" }]);
    const b = mkSearchCall([{ thread_id: "T3" }, { thread_id: "T4" }]);
    const out = extractCrossThreadHits([a, b], "T1").sort();
    expect(out).toEqual(["T2", "T3", "T4"]);
  });

  it("handles double-stringified output_preview (qa-blind 2026-05-27 fix)", () => {
    const inner = JSON.stringify({ hits: [{ thread_id: "T2", title: "x" }] });
    const doubled = JSON.stringify(inner);
    const tc: ToolCallTrace = {
      name: "memory__search",
      input_preview: "{}",
      output_preview: doubled,
      ms: 5,
      status: "ok",
    };
    expect(extractCrossThreadHits([tc], "T1")).toEqual(["T2"]);
  });
});
