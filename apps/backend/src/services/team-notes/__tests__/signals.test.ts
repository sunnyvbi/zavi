import { describe, it, expect } from "vitest";
import {
  buildRunToolFacts, classifyRunError, detectRunEndSignals, isHardRunFailure, noteSurface,
  sortBySignalPrecedence, teamNoteFingerprint,
} from "../signals";
import { EMPTY_COMPLETION_ERROR } from "@/services/agents/outcome-model";

const ok = (name: string) => ({ name, status: "ok", input_preview: "", output_preview: "", ms: 1 });
const bad = (name: string, code = "http_500") =>
  ({ name, status: "tool_error", code, input_preview: "", output_preview: "", ms: 1 });
const base = { status: "success", error: null as string | null, toolCalls: [] as unknown[], groundingFlags: [], operatorShapes: [], willRetry: false };
const run = (p: Record<string, unknown>) => detectRunEndSignals({ ...base, ...p } as never);

describe("detectRunEndSignals", () => {
  it("clean run: no signals", () => {
    expect(run({ toolCalls: [ok("a"), ok("b")] }).signals).toEqual([]);
  });

  it("same tool non-ok twice", () => {
    const r = run({ toolCalls: [bad("meta_ads__insights"), ok("x"), { ...bad("meta_ads__insights"), status: "throw" }] });
    expect(r.signals).toEqual(["tool_repeat_failure"]);
    expect(r.tool).toBe("meta_ads__insights");
    expect(r.errorCode).toBe("http_500");
  });

  it("a tool that failed twice and then worked was recovered from: no repeat failure", () => {
    expect(run({ toolCalls: [bad("t"), bad("t"), ok("t")] }).signals).toEqual([]);
    expect(run({ toolCalls: [bad("t"), ok("u"), bad("t"), ok("x"), ok("t")] }).signals).toEqual([]);
  });

  it("an ok call BEFORE the second failure is not recovery: still flags", () => {
    const r = run({ toolCalls: [bad("t"), ok("t"), bad("t")] });
    expect(r.signals).toEqual(["tool_repeat_failure"]);
    expect(r.tool).toBe("t");
    expect(run({ toolCalls: [ok("t"), bad("t"), bad("t"), ok("other")] }).signals).toEqual(["tool_repeat_failure"]);
  });

  it("one tool recovered and another did not: the unrecovered one is reported", () => {
    const r = run({ toolCalls: [bad("a"), bad("a"), ok("a"), bad("b"), bad("b")] });
    expect(r.signals).toEqual(["tool_repeat_failure"]);
    expect(r.tool).toBe("b");
  });

  it("two DIFFERENT tools failing once each is not a repeat failure", () => {
    expect(run({ toolCalls: [bad("a"), bad("b")] }).signals).toEqual([]);
  });

  it("operator shapes: only dead-end-punt and capability-denial count", () => {
    const r = run({ operatorShapes: ["dead-end-punt", "metric-mislabel", "capability-denial"] });
    expect(r.signals).toEqual(["dead_end_punt", "capability_denial"]);
    expect(r.failureShape).toBe("dead-end-punt");
  });

  it("hard grounding flag counts, soft does not", () => {
    expect(run({ groundingFlags: [{ pattern: "p", severity: "soft" }] }).signals).toEqual([]);
    expect(run({ groundingFlags: [{ pattern: "p", severity: "hard" }] }).signals).toEqual(["hard_grounding_flag"]);
  });

  it("empty completion counts as its own signal, not run_failed", () => {
    expect(run({ status: "failed", error: EMPTY_COMPLETION_ERROR }).signals).toEqual(["empty_completion"]);
  });

  it("fail-soft generation tool that produced nothing counts", () => {
    const preview = JSON.stringify([{ type: "text", text: JSON.stringify({ generated: 0, skipped: [{ index: 0, reason: "blocked", detail: "policy" }] }) }]);
    const r = run({ toolCalls: [{ ...ok("generate_image"), output_preview: preview }] });
    expect(r.signals).toEqual(["tool_no_output"]);
    expect(r.tool).toBe("generate_image");
  });

  it.each([
    ["dispatch_error", "model call failed: 500"],
    ["failed", "watchdog_reap: no progress for 900s"],
    ["parse_failed", "envelope parse error"],
  ])("run_failed: %s with an error", (status, error) => {
    expect(run({ status, error }).signals).toEqual(["run_failed"]);
  });

  it("run_failed carries a coarse, text-free error class for the fingerprint", () => {
    expect(run({ status: "dispatch_error", error: "watchdog_reap" }).errorCode).toBe("infra_reap");
  });

  it.each([
    ["cancelled (user stop)", { status: "cancelled", error: null }],
    ["cancelled error string", { status: "dispatch_error", error: "run_cancelled" }],
    ["insufficient credits", { status: "dispatch_error", error: "insufficient_credits: balance 0" }],
    ["usage limit", { status: "dispatch_error", error: "usage limit reached, resets at 5pm" }],
    ["infra retry will re-fire it", { status: "dispatch_error", error: "boot_reap", willRetry: true }],
    ["failed with no error text", { status: "failed", error: null }],
  ])("never flags: %s", (_l, p) => {
    expect(run(p as Record<string, unknown>).signals).toEqual([]);
  });
});

describe("detectRunEndSignals: looping (2026-09-30 postmortem)", () => {
  const call = (name: string, input: string, status = "ok") =>
    ({ name, status, input_preview: input, output_preview: "", ms: 1 });

  it("MUST catch: 34 identical SUCCESSFUL calls of one tool = tool_loop", () => {
    const r = run({ toolCalls: Array.from({ length: 34 }, () => call("operator_db__query", '{"sql":"select count(*) from bookings"}')) });
    expect(r.signals).toContain("tool_loop");
    expect(r.tool).toBe("operator_db__query");
    expect(sortBySignalPrecedence(r.signals)[0]).toBe("tool_loop");
  });

  it("tool_loop matches inputs that differ only in case and whitespace", () => {
    const r = run({ toolCalls: [call("t", '{"q": "A"}'), call("t", '{"q":  "a"}\n'), call("t", ' {"Q": "a"}')] });
    expect(r.signals).toEqual(["tool_loop"]);
  });

  it("tool_loop counts any status, interleaved with other calls", () => {
    const r = run({ toolCalls: [call("t", "x"), call("u", "y"), call("t", "x", "tool_error"), call("t", "x", "throw")] });
    expect(r.signals).toEqual(["tool_repeat_failure", "tool_loop"]);
  });

  it("blank input previews are unknown input, not the same input: no tool_loop", () => {
    const r = run({ toolCalls: Array.from({ length: 5 }, () => ok("q")) });
    expect(r.signals).not.toContain("tool_loop");
  });

  it("tool_thrash alone (10 calls, DIFFERENT inputs) does not flag the reply", () => {
    const r = run({ toolCalls: Array.from({ length: 10 }, (_, i) => call("web_fetch", `{"url":"https://a.com/${i}"}`)) });
    expect(r).toEqual({ signals: [], tool: null, errorCode: null, failureShape: null });
  });

  it("tool_thrash still rides along when another signal fired", () => {
    const calls = [...Array.from({ length: 10 }, (_, i) => call("web_fetch", `{"url":"https://a.com/${i}"}`)), call("web_fetch", "x"), call("web_fetch", "x"), call("web_fetch", "x")];
    expect(run({ toolCalls: calls }).signals).toEqual(["tool_loop", "tool_thrash"]);
  });

  it("20 DIFFERENT database queries with 2 recovered guard refusals: no team note", () => {
    const calls = [
      ...Array.from({ length: 20 }, (_, i) => call("operator_db__query", `{"collection":"orders","pipeline":[{"$limit":${i + 1}}]}`)),
      { ...call("operator_db__query", '{"sql":"select hidden_col from orders"}', "tool_error"), code: "data_access_refused" },
      { ...call("operator_db__query", '{"pipeline":[{"$limit":10000}]}', "tool_error"), code: "operator_db_read_rejected" },
    ];
    expect(run({ toolCalls: calls }).signals).toEqual([]);
  });

  it("guard refusals do not count as tool failures, other errors still do", () => {
    const refused = (code: string) => ({ ...call("operator_db__query", code, "tool_error"), code });
    expect(run({ toolCalls: [refused("data_access_refused"), refused("tenant_tool_deny")] }).signals).toEqual([]);
    expect(run({ toolCalls: [refused("data_access_refused"), refused("http_500"), refused("timeout")] }).signals).toEqual(["tool_repeat_failure"]);
  });

  it("the same refused input 3x is still a loop", () => {
    const same = { ...call("operator_db__query", '{"pipeline":[{"$limit":10000}]}', "tool_error"), code: "operator_db_read_rejected" };
    expect(run({ toolCalls: [same, same, same] }).signals).toEqual(["tool_loop"]);
  });

  it("MUST NOT catch: 2 identical calls", () => {
    expect(run({ toolCalls: [call("t", "x"), call("t", "x")] }).signals).toEqual([]);
  });

  it("MUST NOT catch: 9 calls of one tool with different inputs", () => {
    expect(run({ toolCalls: Array.from({ length: 9 }, (_, i) => call("t", `in-${i}`)) }).signals).toEqual([]);
  });

  it("MUST NOT catch: 10 calls spread across different tools", () => {
    expect(run({ toolCalls: Array.from({ length: 10 }, (_, i) => call(`t${i % 5}`, `in-${i}`)) }).signals).toEqual([]);
  });

  it("thresholds are tunable; a nonsense threshold falls back to the default", () => {
    const four = Array.from({ length: 4 }, () => call("t", "x"));
    expect(run({ toolCalls: four, loopThreshold: 5 }).signals).toEqual([]);
    expect(run({ toolCalls: four.slice(0, 2), loopThreshold: 2 }).signals).toEqual(["tool_loop"]);
    expect(run({ toolCalls: four.slice(0, 3), loopThreshold: 0 }).signals).toEqual(["tool_loop"]);
    const five = Array.from({ length: 5 }, (_, i) => call("t", `in-${i}`));
    expect(run({ toolCalls: [...five, bad("t"), bad("t")], thrashThreshold: 5 }).signals).toEqual(["tool_repeat_failure", "tool_thrash"]);
    expect(run({ toolCalls: five, thrashThreshold: Number.NaN }).signals).toEqual([]);
  });

  it("a failed run is still only run_failed (looping is a success-path signal)", () => {
    const r = run({ status: "dispatch_error", error: "model call failed", toolCalls: Array.from({ length: 5 }, () => call("t", "x")) });
    expect(r.signals).toEqual(["run_failed"]);
  });
});

describe("buildRunToolFacts", () => {
  const call = (name: string, input: string, status = "ok") => ({ name, status, input_preview: input, output_preview: "OUT" });
  it("guard refusals are reported as refused, not failed, and do not qualify a tool", () => {
    const refused = { name: "q", status: "tool_error", code: "data_access_refused", input_preview: "a", output_preview: "" };
    expect(buildRunToolFacts([refused, { ...refused, input_preview: "b" }])).toEqual([]);
    expect(buildRunToolFacts([refused, refused, refused])).toEqual(["tool q called 3 times, 0 ok, 0 failed, 3 refused by Zavi's own guard, same input 3 times"]);
  });

  it("one line per offending tool: names, counts, statuses only", () => {
    const facts = buildRunToolFacts([
      ...Array.from({ length: 4 }, () => call("q", "secret input")),
      call("f", "a", "tool_error"), call("f", "b", "throw"),
      call("fine", "x"),
      ...Array.from({ length: 10 }, (_, i) => call("web_fetch", `https://a.com/${i}`)),
    ]);
    expect(facts).toEqual([
      "tool web_fetch called 10 times, 10 ok, 0 failed",
      "tool q called 4 times, 4 ok, 0 failed, same input 4 times",
      "tool f called 2 times, 0 ok, 2 failed",
    ]);
    expect(facts.join(" ")).not.toMatch(/secret|OUT|https/);
  });
  it("strips odd characters from a tool name and caps at 5 tools", () => {
    const calls = Array.from({ length: 7 }, (_, t) => Array.from({ length: 3 }, () => call(`t${t}<script>`, "x"))).flat();
    const facts = buildRunToolFacts(calls);
    expect(facts).toHaveLength(5);
    expect(facts[0]).toMatch(/^tool t\dscript called 3 times/);
  });
  it("garbage in: no facts, never throws", () => {
    expect(buildRunToolFacts(null)).toEqual([]);
    expect(buildRunToolFacts("x")).toEqual([]);
    expect(buildRunToolFacts([null, 1, { name: 3 }])).toEqual([]);
  });
});

describe("sortBySignalPrecedence", () => {
  it("orders by the fixed precedence, dedups, and is independent of input order", () => {
    expect(sortBySignalPrecedence(["tool_repeat_failure", "run_failed", "founder_correction", "run_failed"]))
      .toEqual(["founder_correction", "run_failed", "tool_repeat_failure"]);
    expect(sortBySignalPrecedence(["founder_correction", "tool_repeat_failure", "run_failed"]))
      .toEqual(["founder_correction", "run_failed", "tool_repeat_failure"]);
  });
  it("places the loop signals right after tool_repeat_failure and frustration right after correction", () => {
    expect(sortBySignalPrecedence(["tool_no_output", "tool_thrash", "tool_loop", "tool_repeat_failure"]))
      .toEqual(["tool_repeat_failure", "tool_loop", "tool_thrash", "tool_no_output"]);
    expect(sortBySignalPrecedence(["founder_edit", "founder_frustration", "founder_correction"]))
      .toEqual(["founder_correction", "founder_frustration", "founder_edit"]);
  });
  it("drops unknown codes", () => {
    expect(sortBySignalPrecedence(["nope", "empty_completion"])).toEqual(["empty_completion"]);
  });
});

describe("teamNoteFingerprint", () => {
  it("is 16 hex chars, stable, and depends on agent + signal + tool + code + shape", () => {
    const a = teamNoteFingerprint({ agentSlug: "operator", signal: "tool_repeat_failure", tool: "t", errorCode: "c", failureShape: null });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(teamNoteFingerprint({ agentSlug: "operator", signal: "tool_repeat_failure", tool: "t", errorCode: "c", failureShape: null })).toBe(a);
    expect(teamNoteFingerprint({ agentSlug: "pm", signal: "tool_repeat_failure", tool: "t", errorCode: "c", failureShape: null })).not.toBe(a);
    expect(teamNoteFingerprint({ agentSlug: "operator", signal: "tool_loop", tool: "t", errorCode: "c", failureShape: null })).not.toBe(a);
  });
});

describe("classifyRunError (bounded patterns)", () => {
  it.each([
    ["watchdog_reap: no progress for >30min", "infra_reap"],
    ["boot_reap: orphaned by container restart", "infra_reap"],
    ["stale_reap: queued >2h, never claimed", "infra_reap"],
    ["run terminated: reap-threshold exceeded", "infra_reap"],
    ["run was reaped", "infra_reap"],
    ["orphaned run", "infra_reap"],
    ["anthropic 529 overloaded", "provider_capacity"],
    ["HTTP 429 Too Many Requests", "provider_capacity"],
    ["provider overloaded", "provider_capacity"],
    ["rate limit exceeded", "provider_capacity"],
    ["rate_limit_error", "provider_capacity"],
    ["request timed out after 600s", "timeout"],
    ["envelope parse failed", "parse"],
    ["could not generate the report", "other"],
    ["moderate accuracy", "other"],
    ["the reaper module crashed", "other"],
    ["order 14290 not found", "other"],
  ])("%s -> %s", (error, cls) => {
    expect(classifyRunError(error)).toBe(cls);
  });

  it("null and empty are other", () => {
    expect(classifyRunError(null)).toBe("other");
    expect(classifyRunError("")).toBe("other");
  });
});

describe("isHardRunFailure (from the run row)", () => {
  it("a failed run with a reply-side error is a hard failure", () => {
    expect(isHardRunFailure("failed", "tool crashed")).toBe(true);
    expect(isHardRunFailure("dispatch_error", "could not generate")).toBe(true);
    expect(isHardRunFailure("failed", EMPTY_COMPLETION_ERROR)).toBe(true);
  });

  it.each([
    ["success", null],
    ["cancelled", null],
    ["running", null],
    [null, null],
    ["dispatch_error", "watchdog_reap: stale"],
    ["failed", "anthropic 529 overloaded"],
    ["dispatch_error", "run_cancelled"],
    ["dispatch_error", "insufficient_credits: balance 0"],
  ])("not a hard failure: %s / %s", (status, error) => {
    expect(isHardRunFailure(status, error)).toBe(false);
  });
});

describe("noteSurface", () => {
  it("founder pushback is a strip", () => {
    expect(noteSurface({ signals: ["founder_correction"], errorClass: null })).toBe("strip");
    expect(noteSurface({ signals: ["founder_frustration"], errorClass: null })).toBe("strip");
  });

  it("a hard run failure is a strip, unless the cause is ours (reap / provider capacity)", () => {
    expect(noteSurface({ signals: ["run_failed"], errorClass: "other" })).toBe("strip");
    expect(noteSurface({ signals: ["run_failed"], errorClass: "timeout" })).toBe("strip");
    expect(noteSurface({ signals: ["empty_completion"], errorClass: "other" })).toBe("strip");
    expect(noteSurface({ signals: ["empty_completion"], errorClass: null })).toBe("strip");
    expect(noteSurface({ signals: ["run_failed"], errorClass: "infra_reap" })).toBe("flag");
    expect(noteSurface({ signals: ["run_failed"], errorClass: "provider_capacity" })).toBe("flag");
  });

  it.each([
    "hard_grounding_flag", "tool_repeat_failure", "tool_loop", "tool_thrash", "tool_no_output",
    "dead_end_punt", "capability_denial", "founder_rephrase", "founder_edit",
  ])("%s alone is a flag", (sig) => {
    expect(noteSurface({ signals: [sig], errorClass: null })).toBe("flag");
  });

  it("pushback wins over a reap", () => {
    expect(noteSurface({ signals: ["run_failed", "founder_correction"], errorClass: "infra_reap" })).toBe("strip");
  });
});
