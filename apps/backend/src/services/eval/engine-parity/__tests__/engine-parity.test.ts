
import { describe, expect, it } from "vitest";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";
import { estimateParityCostUsd } from "../pricing";
import {
  assertEngineCell,
  buildBlindJudgePrompt,
  buildJudgeFamilyLadder,
  buildParityDiff,
  buildParityReport,
  type BlindJudgeVerdict,
  type EngineCell,
  type EngineRunCapture,
  type ParityTask,
  extractFirstJsonObject,
  formatParityReport,
  parseBlindJudgeReply,
  PARITY_SCORE_TOLERANCE,
  runParitySuite,
  skipEngineCell,
} from "../engine-parity";
import type { Provider } from "@/services/llm/models";

const ZERO_USAGE: NormalizedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function task(over: Partial<ParityTask> = {}): ParityTask {
  return {
    task_id: "t1",
    agent_slug: "pm",
    label: "test task",
    system: "sys",
    prompt: "do the thing",
    ...over,
  };
}

function capture(over: Partial<EngineRunCapture> = {}): EngineRunCapture {
  return {
    output: "a real non-empty answer",
    latency_ms: 1200,
    usage: { ...ZERO_USAGE, input_tokens: 1000, output_tokens: 500 },
    model: "claude-opus-4-7",
    gated_tool_calls: 0,
    errored: false,
    ...over,
  };
}

describe("estimateParityCostUsd", () => {
  it("prices Anthropic opus input+output at the published per-MTok rate", () => {
    const usage: NormalizedUsage = { ...ZERO_USAGE, input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(estimateParityCostUsd("claude-opus-4-7", usage)).toBe(30);
  });

  it("applies the cache-read discount (0.10×) to input", () => {
    const usage: NormalizedUsage = { ...ZERO_USAGE, cache_read_input_tokens: 1_000_000 };
    expect(estimateParityCostUsd("claude-opus-4-7", usage)).toBe(0.5);
  });

  it("prices the OpenAI flagship model", () => {
    const usage: NormalizedUsage = { ...ZERO_USAGE, input_tokens: 1_000_000, output_tokens: 0 };
    expect(estimateParityCostUsd("gpt-5.5", usage)).toBe(5);
  });

  it("falls back to the top tier for an unknown model (never undercounts)", () => {
    const usage: NormalizedUsage = { ...ZERO_USAGE, input_tokens: 1_000_000 };
    expect(estimateParityCostUsd("some-future-model", usage)).toBe(5);
  });

  it("never throws on garbage usage (NormalizedUsage zeros it)", () => {
    expect(() => estimateParityCostUsd("gpt-5.5", ZERO_USAGE)).not.toThrow();
    expect(estimateParityCostUsd("gpt-5.5", ZERO_USAGE)).toBe(0);
  });
});

describe("assertEngineCell", () => {
  it("PASS on a clean run with non-empty output and no tool expectation", () => {
    const cell = assertEngineCell(task(), "anthropic", capture());
    expect(cell.status).toBe("pass");
    expect(cell.reason).toBe("");
    expect(cell.cost_usd).toBeGreaterThan(0);
  });

  it("WATCH-RED when the run errored", () => {
    const cell = assertEngineCell(task(), "openai", capture({ errored: true, error_detail: "stream error" }));
    expect(cell.status).toBe("watch-red");
    expect(cell.reason).toContain("stream error");
  });

  it("WATCH-RED on empty output", () => {
    const cell = assertEngineCell(task(), "anthropic", capture({ output: "   " }));
    expect(cell.status).toBe("watch-red");
    expect(cell.reason).toBe("empty output");
  });

  it("WATCH-RED when a tool-expecting task fires 0 gated tools (gate not observed)", () => {
    const t = task({ expects_tools: ["operator_db__query"] });
    const cell = assertEngineCell(t, "anthropic", capture({ gated_tool_calls: 0 }));
    expect(cell.status).toBe("watch-red");
    expect(cell.reason).toContain("gate not observed");
  });

  it("PASS when a tool-expecting task fires tools through dispatchTool", () => {
    const t = task({ expects_tools: ["operator_db__query"] });
    const cell = assertEngineCell(t, "anthropic", capture({ gated_tool_calls: 2 }));
    expect(cell.status).toBe("pass");
    expect(cell.gated_tool_calls).toBe(2);
  });
});

describe("skipEngineCell", () => {
  it("produces a skip cell that is NOT a pass and carries the reason", () => {
    const cell = skipEngineCell("t1", "openai", "no OPENAI_API_KEY");
    expect(cell.status).toBe("skip");
    expect(cell.status).not.toBe("pass");
    expect(cell.reason).toBe("no OPENAI_API_KEY");
    expect(cell.cost_usd).toBe(0);
    expect(cell.latency_ms).toBe(0);
  });
});

describe("parseBlindJudgeReply", () => {
  it("parses a clean JSON verdict", () => {
    const v = parseBlindJudgeReply("t1", '{"score_a":4,"score_b":3,"winner":"A","justification":"A is tighter"}');
    expect(v.error).toBeUndefined();
    expect(v.score_a).toBe(4);
    expect(v.score_b).toBe(3);
    expect(v.winner_label).toBe("A");
    expect(v.justification).toBe("A is tighter");
  });

  it("tolerates fenced code blocks + surrounding prose", () => {
    const raw = "Here is my verdict:\n```json\n{\"score_a\":5,\"score_b\":5,\"winner\":\"tie\",\"justification\":\"equal\"}\n```\nDone.";
    const v = parseBlindJudgeReply("t1", raw);
    expect(v.error).toBeUndefined();
    expect(v.winner_label).toBe("tie");
  });

  it("normalizes lowercase / unknown winner to tie", () => {
    const v = parseBlindJudgeReply("t1", '{"score_a":3,"score_b":3,"winner":"b","justification":"x"}');
    expect(v.winner_label).toBe("B");
    const v2 = parseBlindJudgeReply("t1", '{"score_a":3,"score_b":3,"winner":"neither","justification":"x"}');
    expect(v2.winner_label).toBe("tie");
  });

  it("returns an error verdict (not a throw) on no JSON", () => {
    const v = parseBlindJudgeReply("t1", "I cannot decide.");
    expect(v.error).toBeDefined();
    expect(v.winner_label).toBe("tie");
    expect(v.score_a).toBe(0);
  });

  it("returns an error verdict on out-of-range scores", () => {
    const v = parseBlindJudgeReply("t1", '{"score_a":9,"score_b":3,"winner":"A","justification":"x"}');
    expect(v.error).toBeDefined();
  });
});

describe("extractFirstJsonObject", () => {
  it("handles braces inside string literals", () => {
    const out = extractFirstJsonObject('prefix {"k":"a}b{c"} suffix');
    expect(out).toBe('{"k":"a}b{c"}');
  });
  it("returns null when there is no object", () => {
    expect(extractFirstJsonObject("no braces here")).toBeNull();
  });
});

describe("buildBlindJudgePrompt", () => {
  it("includes both answers but NEVER the provider names (blind)", () => {
    const { system, user } = buildBlindJudgePrompt(task(), "anthropic answer text", "openai answer text");
    expect(system).toContain("blind-judging");
    expect(user).toContain("anthropic answer text");
    expect(user).toContain("openai answer text");
    expect(user).toContain("ANSWER A");
    expect(user).toContain("ANSWER B");
  });

  it("omitting the atom rubric input yields the SAME prompt as before (byte-identical)", () => {
    const noArg = buildBlindJudgePrompt(task(), "ans a", "ans b");
    const undefinedArg = buildBlindJudgePrompt(task(), "ans a", "ans b", undefined);
    const emptyArg = buildBlindJudgePrompt(task(), "ans a", "ans b", {});
    expect(undefinedArg.user).toBe(noArg.user);
    expect(emptyArg.user).toBe(noArg.user);
    const zeroAtoms = buildBlindJudgePrompt(task(), "ans a", "ans b", {
      a: { grade: 0, surviving: 0, total: 0 },
    });
    expect(zeroAtoms.user).toBe(noArg.user);
  });

  it("renders the atom pre-score as an ADVISORY rubric input, NOT an override", () => {
    const { system, user } = buildBlindJudgePrompt(task(), "ans a", "ans b", {
      a: { grade: 0.2, surviving: 1, total: 5 },
      b: { grade: 1, surviving: 3, total: 3 },
    });
    expect(user).toContain("MECHANICAL ATOM-GROUNDING PRE-SCORE (ANSWER A");
    expect(user).toContain("MECHANICAL ATOM-GROUNDING PRE-SCORE (ANSWER B");
    expect(user).toContain("grade=20% (1/5");
    expect(user).toContain("grade=100% (3/3");
    expect(system).toContain("advisory rubric input");
    expect(system).toContain("must NEVER override");
    expect(system).toContain('"score_a": <0-5>');
  });

  it("renders only the supplied side when one answer has no atom score", () => {
    const { user } = buildBlindJudgePrompt(task(), "ans a", "ans b", {
      a: { grade: 0.5, surviving: 2, total: 4 },
    });
    expect(user).toContain("PRE-SCORE (ANSWER A");
    expect(user).not.toContain("PRE-SCORE (ANSWER B");
  });
});

describe("buildJudgeFamilyLadder — D2 codex-as-2nd-family swap", () => {
  it("generic path is codex-primary → grok → gemini", () => {
    const ladder = buildJudgeFamilyLadder({ homeDir: "/home/x", env: {} });
    expect(ladder.map((f) => f.name)).toEqual(["codex", "grok", "gemini"]);
    expect(ladder[0].wrapper).toContain("/home/x/.claude/skills/super-engineer/lib/codex-call.sh");
  });

  it("excludeOpenAiFamily drops codex (shadow-grade fairness: never judge own family)", () => {
    const ladder = buildJudgeFamilyLadder({
      excludeOpenAiFamily: true,
      homeDir: "/home/x",
      env: {},
    });
    expect(ladder.map((f) => f.name)).toEqual(["grok", "gemini"]);
    expect(ladder.some((f) => f.name === "codex")).toBe(false);
  });

  it("wrapper paths are env-overridable", () => {
    const ladder = buildJudgeFamilyLadder({
      homeDir: "/home/x",
      env: { CODEX_CALL_SH: "/custom/codex.sh", GROK_CALL_SH: "/custom/grok.sh" },
    });
    expect(ladder.find((f) => f.name === "codex")?.wrapper).toBe("/custom/codex.sh");
    expect(ladder.find((f) => f.name === "grok")?.wrapper).toBe("/custom/grok.sh");
  });
});

function cell(over: Partial<EngineCell>): EngineCell {
  return {
    task_id: "t1",
    provider: "anthropic",
    status: "pass",
    reason: "",
    output: "out",
    latency_ms: 1000,
    cost_usd: 0.01,
    usage: ZERO_USAGE,
    gated_tool_calls: 0,
    ...over,
  };
}

function verdict(over: Partial<BlindJudgeVerdict>): BlindJudgeVerdict {
  return { task_id: "t1", winner_label: "tie", score_a: 4, score_b: 4, justification: "j", ...over };
}

describe("buildParityDiff classification", () => {
  const A = cell({ provider: "anthropic", status: "pass" });
  const O = (p: Partial<EngineCell>) => cell({ provider: "openai", status: "pass", ...p });
  const map = { A: "anthropic" as Provider, B: "openai" as Provider };

  it("PARITY when both pass and blind gap is within tolerance", () => {
    const d = buildParityDiff(task(), A, O({}), verdict({ score_a: 4, score_b: 4 }), map);
    expect(d.classification).toBe("parity");
    expect(d.blind?.winner).toBe("tie");
    expect(d.blind?.anthropic_score).toBe(4);
    expect(d.blind?.openai_score).toBe(4);
  });

  it("DIVERGED when both pass but the blind gap exceeds tolerance", () => {
    const d = buildParityDiff(task(), A, O({}), verdict({ score_a: 5, score_b: 2, winner_label: "A" }), map);
    expect(d.classification).toBe("diverged");
    expect(d.blind?.winner).toBe("anthropic");
    expect(Math.abs(d.blind!.anthropic_score - d.blind!.openai_score)).toBeGreaterThan(PARITY_SCORE_TOLERANCE);
  });

  it("un-randomizes the winner via the label map (openai shown as A)", () => {
    const flippedMap = { A: "openai" as Provider, B: "anthropic" as Provider };
    const d = buildParityDiff(task(), A, O({}), verdict({ winner_label: "A", score_a: 5, score_b: 5 }), flippedMap);
    expect(d.blind?.winner).toBe("openai");
  });

  it("DIVERGED (conservative) when both pass but the blind judge errored", () => {
    const d = buildParityDiff(task(), A, O({}), verdict({ error: "no json" }), map);
    expect(d.classification).toBe("diverged");
  });

  it("ONE-SIDED when exactly one lane passes and openai actually RAN (watch-red)", () => {
    const d = buildParityDiff(task(), A, O({ status: "watch-red", reason: "empty output" }), null, null);
    expect(d.classification).toBe("one-sided");
  });

  it("SKIPPED when the openai lane was skipped", () => {
    const skipped = skipEngineCell("t1", "openai", "no key");
    const d = buildParityDiff(task(), A, skipped, null, null);
    expect(d.classification).toBe("skipped");
    expect(d.latency_delta_ms).toBeNull();
    expect(d.cost_delta_usd).toBeNull();
  });

  it("BOTH-RED when neither lane passes (and openai ran)", () => {
    const d = buildParityDiff(
      task(),
      cell({ provider: "anthropic", status: "watch-red", reason: "err" }),
      O({ status: "watch-red", reason: "err" }),
      null,
      null,
    );
    expect(d.classification).toBe("both-red");
  });

  it("computes latency + cost deltas when both lanes ran", () => {
    const d = buildParityDiff(
      task(),
      cell({ provider: "anthropic", latency_ms: 1000, cost_usd: 0.02 }),
      O({ latency_ms: 1500, cost_usd: 0.03 }),
      verdict({}),
      map,
    );
    expect(d.latency_delta_ms).toBe(500);
    expect(d.cost_delta_usd).toBe(0.01);
  });
});

describe("buildParityReport + formatParityReport", () => {
  function makeDiffs() {
    const A = cell({ provider: "anthropic", status: "pass", latency_ms: 1000, cost_usd: 0.02 });
    const Opass = cell({ provider: "openai", status: "pass", latency_ms: 1100, cost_usd: 0.03 });
    const parityDiff = buildParityDiff(task({ task_id: "p1", label: "parity one" }), A, Opass, verdict({ score_a: 4, score_b: 4 }), { A: "anthropic", B: "openai" });

    const Ared = cell({ task_id: "p2", provider: "anthropic", status: "watch-red", reason: "empty output", latency_ms: 0, cost_usd: 0 });
    const Oskip = skipEngineCell("p2", "openai", "no OPENAI_API_KEY / --live not set");
    const mixedDiff = buildParityDiff(task({ task_id: "p2", label: "skipped two" }), Ared, Oskip, null, null);

    return [parityDiff, mixedDiff];
  }

  it("counts cells honestly: pass / skip / watch-red + total cells", () => {
    const report = buildParityReport(makeDiffs());
    expect(report.total_cells).toBe(4);
    expect(report.pass).toBe(2);
    expect(report.skip).toBe(1);
    expect(report.watch_red).toBe(1);
    expect(report.gate_cells).toBe(3);
    expect(report.parity_tasks).toBe(1);
    expect(report.skipped_tasks).toBe(1);
  });

  it("sums total cost across run cells only", () => {
    const report = buildParityReport(makeDiffs());
    expect(report.total_cost_usd).toBe(0.05);
  });

  it("formats a qa-api headline that is NEVER a bare N/N (shows skip + watch-red + total)", () => {
    const out = formatParityReport(buildParityReport(makeDiffs()));
    expect(out).toMatch(/GATE:\s*2\/3 PASS/);
    expect(out).toContain("1 SKIP");
    expect(out).toContain("1 WATCH-RED");
    expect(out).toContain("4 cells attempted");
    expect(out).toContain("2 tasks");
  });

  it("names every SKIP line with its precondition (skips are not passes)", () => {
    const out = formatParityReport(buildParityReport(makeDiffs()));
    expect(out).toContain("SKIP (not a pass");
    expect(out).toContain("p2 [openai]: no OPENAI_API_KEY / --live not set");
  });

  it("names every WATCH-RED line with the failing assertion", () => {
    const out = formatParityReport(buildParityReport(makeDiffs()));
    expect(out).toContain("WATCH-RED (ran but an assertion failed)");
    expect(out).toContain("p2 [anthropic]: empty output");
  });

  it("renders the per-task Claude-vs-OpenAI diff with the blind verdict", () => {
    const out = formatParityReport(buildParityReport(makeDiffs()));
    expect(out).toContain("[PARITY] p1");
    expect(out).toContain("blind judge: winner=tie");
    expect(out).toContain("anthropic=4/5 openai=4/5");
  });
});

describe("runParitySuite", () => {
  const tasks: ParityTask[] = [task({ task_id: "x1", label: "one" })];

  it("runs anthropic + skips openai when openaiLive=false; never calls the judge", async () => {
    let judgeCalls = 0;
    const report = await runParitySuite(tasks, {
      runTask: async (_t, provider) => capture({ model: provider === "anthropic" ? "claude-opus-4-7" : "gpt-5.5" }),
      openaiLive: false,
      openaiSkipReason: "no OPENAI_API_KEY / --live not set",
      judge: async () => {
        judgeCalls++;
        return "{}";
      },
      flip: () => true,
    });
    expect(report.diffs[0].anthropic.status).toBe("pass");
    expect(report.diffs[0].openai.status).toBe("skip");
    expect(report.diffs[0].classification).toBe("skipped");
    expect(judgeCalls).toBe(0);
  });

  it("runs both lanes + the blind judge when openaiLive=true and both pass", async () => {
    const report = await runParitySuite(tasks, {
      runTask: async (_t, provider) => capture({ model: provider === "anthropic" ? "claude-opus-4-7" : "gpt-5.5", output: `${provider} answer` }),
      openaiLive: true,
      openaiSkipReason: "n/a",
      judge: async () => '{"score_a":4,"score_b":4,"winner":"tie","justification":"equal"}',
      flip: () => true,
    });
    expect(report.diffs[0].anthropic.status).toBe("pass");
    expect(report.diffs[0].openai.status).toBe("pass");
    expect(report.diffs[0].classification).toBe("parity");
    expect(report.diffs[0].blind?.winner).toBe("tie");
  });

  it("turns a thrown live error into a watch-red cell (never aborts the suite)", async () => {
    const report = await runParitySuite([task({ task_id: "x1" }), task({ task_id: "x2" })], {
      runTask: async (t, provider) => {
        if (t.task_id === "x1" && provider === "anthropic") throw new Error("boom");
        return capture();
      },
      openaiLive: false,
      openaiSkipReason: "skip",
    });
    expect(report.diffs[0].anthropic.status).toBe("watch-red");
    expect(report.diffs[1].anthropic.status).toBe("pass");
    expect(report.diffs).toHaveLength(2);
  });

  it("records a judge-error verdict (not a throw) when the judge call throws", async () => {
    const report = await runParitySuite(tasks, {
      runTask: async () => capture(),
      openaiLive: true,
      openaiSkipReason: "n/a",
      judge: async () => {
        throw new Error("judge down");
      },
      flip: () => true,
    });
    expect(report.diffs[0].blind?.error).toContain("judge call threw");
    expect(report.diffs[0].classification).toBe("diverged");
  });
});
