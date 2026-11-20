
import { describe, it, expect } from "vitest";
import {
  countSeededFromTraces,
  stampQaCatalogBuildCount,
} from "../post-run";
import type { Digest } from "@/agents/chief-of-staff/output-schema";
import type { DispatcherResult } from "@/services/agents/types";
import type { ToolCallTrace } from "@/services/tools/types";

const ADD = "qa_engineer__add_test_case";

function trace(
  over: Partial<ToolCallTrace> & Pick<ToolCallTrace, "name" | "status">,
): ToolCallTrace {
  return {
    input_preview: "{}",
    output_preview: "{}",
    ms: 1,
    ...over,
  };
}

function resultWith(tool_calls: ToolCallTrace[]): DispatcherResult {
  return {
    output_text: "",
    parsed: null,
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_calls,
  };
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const ADD_SDK = `mcp__server__${ADD}`;

describe("countSeededFromTraces", () => {
  it("counts successful add_test_case traces (legacy bare name)", () => {
    const calls = Array.from({ length: 22 }, (_, i) =>
      trace({ name: ADD, status: "ok", returned_ids: [uuid(i)] }),
    );
    expect(countSeededFromTraces(resultWith(calls))).toBe(22);
  });

  it("counts SDK-path traces with the mcp__ prefix and NO returned_ids — the prod Mode-A bug", () => {
    const calls = Array.from({ length: 18 }, () =>
      trace({ name: ADD_SDK, status: "ok" }),
    );
    expect(countSeededFromTraces(resultWith(calls))).toBe(18);
  });

  it("excludes failed (tool_error) add calls — the duplicate-title path (both names)", () => {
    const calls = [
      trace({ name: ADD, status: "ok", returned_ids: [uuid(1)] }),
      trace({ name: ADD_SDK, status: "tool_error", code: "duplicate_title" }),
      trace({ name: ADD_SDK, status: "ok" }),
    ];
    expect(countSeededFromTraces(resultWith(calls))).toBe(2);
  });

  it("counts each ok add trace once (no returned_ids dependency)", () => {
    const calls = [
      trace({ name: ADD_SDK, status: "ok" }),
      trace({ name: ADD_SDK, status: "ok" }),
    ];
    expect(countSeededFromTraces(resultWith(calls))).toBe(2);
  });

  it("ignores non-add_test_case tool calls (incl. prefixed siblings)", () => {
    const calls = [
      trace({ name: "mcp__server__qa_engineer__count_test_cases", status: "ok" }),
      trace({ name: "qa_engineer__count_test_cases", status: "ok" }),
      trace({ name: ADD_SDK, status: "ok" }),
    ];
    expect(countSeededFromTraces(resultWith(calls))).toBe(1);
  });
});

function modeADigest(rendered: string, summary: string): Digest {
  return {
    tier1: [],
    tier2: [],
    tier3: [],
    tier4: [{ category: "qa-catalog-build", summary }],
    rendered_markdown: rendered,
  };
}

describe("stampQaCatalogBuildCount", () => {
  it("stamps header + tier4 from traces, ignoring the LLM-typed count", () => {
    const calls = Array.from({ length: 22 }, (_, i) =>
      trace({ name: ADD, status: "ok", returned_ids: [uuid(i)] }),
    );
    const env = modeADigest(
      "qa seeded **18** test cases from your company brain.\n\n- a\n- b",
      "Seeded 18 test cases covering signup.",
    );
    const out = stampQaCatalogBuildCount(env, resultWith(calls));
    expect(out.tier4[0].summary).toContain("22");
    expect(out.rendered_markdown).toContain("qa seeded **22** test case");
    expect(out.rendered_markdown).not.toContain("18");
    expect(out.rendered_markdown).toContain("- a");
    expect(out.rendered_markdown).toContain("- b");
  });

  it("stamps 0 honestly when no inserts succeeded (singular grammar)", () => {
    const env = modeADigest("qa seeded **5** test cases.\n\nbody", "Seeded 5.");
    const out = stampQaCatalogBuildCount(env, resultWith([]));
    expect(out.rendered_markdown).toContain("qa seeded **0** test cases");
    expect(out.tier4[0].summary).toContain("0 test cases");
  });

  it("uses singular grammar at N=1", () => {
    const calls = [trace({ name: ADD, status: "ok", returned_ids: [uuid(1)] })];
    const env = modeADigest("body", "x");
    const out = stampQaCatalogBuildCount(env, resultWith(calls));
    expect(out.rendered_markdown).toContain("qa seeded **1** test case from");
    expect(out.tier4[0].summary).toBe(
      "Seeded 1 test case from your company brain.",
    );
  });

  it("leaves a non-Mode-A digest untouched (Mode C count owned elsewhere)", () => {
    const env: Digest = {
      tier1: [],
      tier2: [],
      tier3: [],
      tier4: [{ category: "qa-chat-add-inserted", summary: "Added 3 cases." }],
      rendered_markdown: "Added 3 cases to the catalog.",
    };
    const calls = [trace({ name: ADD, status: "ok", returned_ids: [uuid(1)] })];
    const out = stampQaCatalogBuildCount(env, resultWith(calls));
    expect(out).toBe(env);
  });

  it("acceptance: header N == tier4 N == countSeededFromTraces", () => {
    const calls = Array.from({ length: 7 }, (_, i) =>
      trace({ name: ADD, status: "ok", returned_ids: [uuid(i)] }),
    );
    const result = resultWith(calls);
    const n = countSeededFromTraces(result);
    const out = stampQaCatalogBuildCount(modeADigest("body", "x"), result);
    expect(n).toBe(7);
    expect(out.rendered_markdown).toContain(`qa seeded **${n}**`);
    expect(out.tier4[0].summary).toContain(`Seeded ${n}`);
  });
});
