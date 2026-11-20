import { describe, it, expect } from "vitest";
import { mapClaudeJsonToDispatcherResult } from "../../../../scripts/lib/envelope-mapper.mjs";
import { DispatcherResultSchema } from "../types";

describe("mapClaudeJsonToDispatcherResult", () => {
  it("maps a clean success claude -p result", () => {
    const result = mapClaudeJsonToDispatcherResult(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "final text",
        usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 5 },
        total_cost_usd: 0.42,
      },
      { status: "done" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("final text");
    expect(result.raw_response_text).toBe("final text");
    expect(result.parsed).toBe(null);
    expect(result.usage.input_tokens).toBe(120);
    expect(result.usage.output_tokens).toBe(80);
    expect(result.usage.cost_usd).toBe(0.42);
    expect(result.usage.cache_read_input_tokens).toBe(5);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.parse_error).toBeUndefined();
  });

  it("coerces string-typed cost/cache fields to numbers (codex P2), omits non-numeric", () => {
    const result = mapClaudeJsonToDispatcherResult(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: {
          input_tokens: "120",
          output_tokens: "80",
          cache_read_input_tokens: "5",
          cache_creation_input_tokens: "not-a-number",
        },
        total_cost_usd: "0.42",
        stop_reason: { weird: "object" },
      },
      { status: "done" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.usage.input_tokens).toBe(120);
    expect(result.usage.cost_usd).toBe(0.42);
    expect(result.usage.cache_read_input_tokens).toBe(5);
    expect(result.usage.cache_creation_input_tokens).toBeUndefined();
    expect(typeof result.stop_reason).toBe("string");
  });

  it("maps an error claude -p result", () => {
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "error_during_execution", is_error: true, result: "boom" },
      { status: "failed" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.parse_ok).toBe(false);
    expect(typeof result.parse_error).toBe("string");
    expect((result.parse_error ?? "").length).toBeGreaterThan(0);
    expect(result.stop_reason).toBe("error");
  });

  it("forces parse_ok=false when CLI status is failed even on a clean-looking JSON", () => {
    const result = mapClaudeJsonToDispatcherResult(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "looks fine",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { status: "failed" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.parse_ok).toBe(false);
    expect(typeof result.parse_error).toBe("string");
  });

  it("defaults usage token counts to 0 when usage is absent", () => {
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "success", is_error: false, result: "ok" },
      { status: "done" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("maps max_turns to stop_reason=max_tokens and parse_ok=false", () => {
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "error_max_turns", is_error: true, result: "" },
      { status: "failed" },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.stop_reason).toBe("max_tokens");
    expect(result.parse_ok).toBe(false);
  });

  it("fills prompt_snapshot from opts, and is present (empty string) without opts", () => {
    const withSnap = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "success", is_error: false, result: "x" },
      { status: "done", promptSnapshot: "sys+task" },
    );
    expect(DispatcherResultSchema.safeParse(withSnap).success).toBe(true);
    expect(withSnap.prompt_snapshot).toBe("sys+task");

    const noOpts = mapClaudeJsonToDispatcherResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x",
    });
    expect(DispatcherResultSchema.safeParse(noOpts).success).toBe(true);
    expect(noOpts.prompt_snapshot).toBe("");
  });

  it("forwards a well-shaped local_pr block (design D); server re-validates", () => {
    const lp = {
      pr_number: 7,
      pr_url: "https://github.com/upcar-ai/OraiCar/pull/7",
      pr_repo: "upcar-ai/OraiCar",
      head_branch: "engineer/bbbb",
    };
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "success", is_error: false, result: "ok" },
      { status: "done", localPr: lp },
    );
    expect(DispatcherResultSchema.safeParse(result).success).toBe(true);
    expect(result.local_pr).toEqual(lp);
  });

  it("DROPS a malformed local_pr (the mapper is not an authority)", () => {
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "success", is_error: false, result: "ok" },
      { status: "done", localPr: { pr_number: "5", pr_url: 123 } },
    );
    expect(result.local_pr).toBeUndefined();
  });

  it("omits local_pr when absent (cloud + non-engineer runs)", () => {
    const result = mapClaudeJsonToDispatcherResult(
      { type: "result", subtype: "success", is_error: false, result: "ok" },
      { status: "done" },
    );
    expect(result.local_pr).toBeUndefined();
  });
});
