import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);

describe("generic-dispatcher — Lane B thread_event wiring", () => {
  it("imports emitThreadEvent + emitThreadEventOnce helpers", () => {
    expect(src).toMatch(
      /import \{ emitThreadEvent, emitThreadEventOnce \} from "\.\/thread-event";/,
    );
  });

  it("uses emitThreadEventOnce for the once-per-run emits (run_start, plan)", () => {
    expect(src).toMatch(/teOnce\(ctx\.step, "run-start"/);
    expect(src).toMatch(/teOnce\(ctx\.step, "plan"/);
  });

  it("defines safeEmitThreadEvent wrapper that swallows errors (warn + continue)", () => {
    expect(src).toMatch(/async function safeEmitThreadEvent/);
    expect(src).toMatch(/try \{[\s\S]*?await emitThreadEvent\([\s\S]*?\} catch/);
    expect(src).toMatch(/thread_event emit failed/);
  });

  it("emits a run_start row at the top of runGeneric (kind='run_start' present)", () => {
    expect(src).toMatch(/kind: "run_start"/);
    expect(src).toMatch(/trigger: ctx\.trigger,/);
    expect(src).toMatch(/eta_p50_ms: eta\.p50_ms/);
  });

  it("emits a reasoning row inside the main iter loop (kind='reasoning' + body.iter)", () => {
    const reasoningCount = (src.match(/kind: "reasoning"/g) ?? []).length;
    expect(reasoningCount).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/body: \{ iter, text:/);
  });

  it("emits a tool_call row in all 10 paths: 6 legacy-loop (hallucinated tool, operator policy deny, E-2 egress deny, pm operator_db deny, MCP error, MCP success) + 2 SDK-branch (canUseTool audit start, tool_result complete) + 2 anthropic-engine-branch (tool_start audit, tool_result complete)", () => {
    const toolCallEmits = (src.match(/kind: "tool_call"/g) ?? []).length;
    expect(toolCallEmits).toBe(10);
  });

  it("tool_call body carries the structured fields (tool_name/target/ms/code/output_preview)", () => {
    expect(src).toMatch(/tool_name: fullName\.slice\(0, 64\)/);
    expect(src).toMatch(/target: toolTarget/);
    expect(src).toMatch(/code: "ok"/);
    expect(src).toMatch(/code: "err"/);
    expect(src).toMatch(/output_preview:/);
  });

  it("tool_call error path emits error_message (not crammed into output_preview)", () => {
    expect(src).toMatch(/error_message:/);
  });

  it("deriveToolTarget defined with 256-char cap", () => {
    expect(src).toMatch(/function deriveToolTarget/);
    expect(src).toMatch(/\.slice\(0, 256\)/);
  });

  it("does NOT call emitThreadEvent directly anywhere (must go through safeEmitThreadEvent)", () => {
    const callSites = src.match(/\bemitThreadEvent\(/g) ?? [];
    expect(callSites.length).toBe(1);
  });

  it("re-uses the teEmit chokepoint for every per-iteration emit", () => {
    const teEmits = (src.match(/teEmit\(/g) ?? []).length;
    expect(teEmits).toBeGreaterThanOrEqual(6);
  });
});

describe("generic-dispatcher — Lane C citation wiring", () => {
  it("imports parseCitations + CITATION_INSTRUCTION from citation-parser", () => {
    expect(src).toMatch(
      /import \{ parseCitations, CITATION_INSTRUCTION \} from "\.\/citation-parser";/,
    );
  });

  it("appends CITATION_INSTRUCTION to the stable system-prompt prefix", () => {
    expect(src).toMatch(/s = s \+ "\\n\\n---\\n" \+ CITATION_INSTRUCTION;/);
  });

  it("both reasoning emit sites parse citations BEFORE emitting (per-iter + cap-summarize)", () => {
    const parseCalls = (src.match(/parseCitations\(/g) ?? []).length;
    expect(parseCalls).toBeGreaterThanOrEqual(4);
  });

  it("reasoning thread_event rows carry citations (not empty default)", () => {
    const citationEmits = src.match(
      /kind: "reasoning"[\s\S]+?citations,?\s*\}/g,
    ) ?? [];
    expect(citationEmits.length).toBeGreaterThanOrEqual(2);
  });

  it("strips cite tags from output_text via the rawText path", () => {
    expect(src).toMatch(/parseCitations\(rawText\)/);
    expect(src).toMatch(/outputText = rawTextStripped/);
  });

  it("selects + cite-strips output_text via selectRenderedText helper", () => {
    expect(src).toMatch(/selectRenderedText\(\{/);
    expect(src).toMatch(/outputText = parseCitations\(selection\.text\)\.text/);
  });

  it("emits meta_rm_rescued telemetry on rescueKind via existing parsed stage", () => {
    expect(src).toMatch(/meta_rm_rescued_\$\{selection\.rescueKind\}/);
  });

  it("CITATION_INSTRUCTION is appended ONCE, not duplicated per iteration", () => {
    const appends =
      src.match(/\+ "\\n\\n---\\n" \+ CITATION_INSTRUCTION;/g) ?? [];
    expect(appends.length).toBe(1);
    const oldSplices = src.match(/\$\{CITATION_INSTRUCTION\}/g) ?? [];
    expect(oldSplices.length).toBe(0);
  });
});

describe("generic-dispatcher — plan block stripping (Lane C output_text guard)", () => {
  it("wraps the common normalization seam with stripPlanBlock (prevents <plan> envelope leak in output_text)", () => {
    expect(src).toMatch(
      /const rawText = stripPlanBlock\(finalAssistantText, ctx\.agent\.slug\);/,
    );
  });

  it("wraps the cap-summarize finalRaw seam with stripPlanBlock (defense-in-depth for iter-cap reasoning emit)", () => {
    expect(src).toMatch(
      /const finalRaw = stripPlanBlock\(\s*textOfContent\(finalResp\.content\),\s*ctx\.agent\.slug,?\s*\);/,
    );
  });

  it("imports stripPlanBlock from ./plan-emit (the wire-up's prerequisite)", () => {
    expect(src).toMatch(
      /import \{[^}]*\bstripPlanBlock\b[^}]*\} from "\.\/plan-emit"/,
    );
  });
});
