import { describe, it, expect } from "vitest";
import {
  DelegatedChildResult,
  buildDelegatedChildResult,
  extractReceipts,
} from "../delegation-result-schema";
import type { DispatcherResult } from "../types";

function fakeResult(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "",
    parsed: null,
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    ...over,
  } as DispatcherResult;
}

describe("delegation-result-schema — extractReceipts", () => {
  it("pulls a PR url from the output", () => {
    const r = extractReceipts(
      "Done: https://github.com/rravi149/praxis/pull/412",
      [],
    );
    expect(r).toContain("pr_url:https://github.com/rravi149/praxis/pull/412");
  });

  it("pulls a #1234 ref + a side-effecting tool, dedups, ignores read tools", () => {
    const r = extractReceipts("Filed #1234.", [
      { name: "memory__search" },
      { name: "github__create_pr" },
      { name: "github__create_pr" },
    ]);
    expect(r).toContain("pr_ref:#1234");
    expect(r).toContain("tool:github__create_pr");
    expect(r).not.toContain("tool:memory__search");
    expect(r.filter((x) => x === "tool:github__create_pr")).toHaveLength(1);
  });

  it("prose with no PR + only read tools → no receipts", () => {
    expect(extractReceipts("I shipped it, trust me.", [{ name: "memory__search" }]))
      .toHaveLength(0);
  });

  it("null inputs → empty", () => {
    expect(extractReceipts(null, null)).toEqual([]);
    expect(extractReceipts(undefined, undefined)).toEqual([]);
  });
});

describe("delegation-result-schema — buildDelegatedChildResult", () => {
  it("maps a successful run deterministically with receipts", () => {
    const out = buildDelegatedChildResult({
      run_id: "r1",
      agent_slug: "engineer",
      status: "success",
      result: fakeResult({
        output_text: "Opened https://github.com/rravi149/praxis/pull/9",
        parse_ok: true,
        tool_calls: [{ name: "github__create_pr", input_preview: "", output_preview: "", ms: 1, status: "ok" }],
      }),
    });
    expect(out.status).toBe("success");
    expect(out.parse_ok).toBe(true);
    expect(out.receipts.length).toBeGreaterThan(0);
    expect(out.output_text).toContain("pull/9");
  });

  it("normalizes 'failed' → 'error' and falls back to raw_response_text", () => {
    const out = buildDelegatedChildResult({
      run_id: "r2",
      agent_slug: "support-lead",
      status: "failed",
      result: fakeResult({ output_text: "", raw_response_text: "useful prose", parse_ok: false }),
      error: "boom",
    });
    expect(out.status).toBe("error");
    expect(out.parse_ok).toBe(false);
    expect(out.output_text).toBe("useful prose");
    expect(out.error).toBe("boom");
  });

  it("parse_failed status round-trips the prose (the held-PR-diagnosis case)", () => {
    const out = buildDelegatedChildResult({
      run_id: "r3",
      agent_slug: "engineer",
      status: "parse_failed",
      result: fakeResult({ output_text: "root cause: asymmetric drift", parse_ok: false }),
    });
    expect(out.status).toBe("parse_failed");
    expect(out.output_text).toContain("asymmetric drift");
  });

  it("null result → safe empty object that still parses", () => {
    const out = buildDelegatedChildResult({
      run_id: "r4",
      agent_slug: "x",
      status: "error",
      result: null,
    });
    expect(out.parse_ok).toBe(false);
    expect(out.output_text).toBe("");
    expect(out.receipts).toEqual([]);
  });
});

describe("delegation-result-schema — additive parse (Slice B compat)", () => {
  it("an old/partial shape still parses via defaults", () => {
    const parsed = DelegatedChildResult.parse({
      run_id: "r5",
      agent_slug: "y",
      status: "success",
      parse_ok: true,
    });
    expect(parsed.output_text).toBe("");
    expect(parsed.receipts).toEqual([]);
    expect(parsed.error).toBeNull();
  });

  it("tolerates extra fields Slice B may add (does not throw)", () => {
    const parsed = DelegatedChildResult.parse({
      run_id: "r6",
      agent_slug: "z",
      status: "success",
      parse_ok: true,
      delegation_mode: "full",
    } as Record<string, unknown>);
    expect(parsed.run_id).toBe("r6");
  });
});
