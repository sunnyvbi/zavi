import { describe, it, expect, vi, beforeEach } from "vitest";

const captureSend = vi.fn();
let sendThrows: Error | null = null;
vi.mock("../../../../workers/client", () => ({
  inngest: {
    send: async (...args: unknown[]) => {
      captureSend(...args);
      if (sendThrows) throw sendThrows;
      return { ids: ["mock-event-id"] };
    },
  },
}));

import {
  extractPlanBlock,
  isEmptyPlan,
  maybeEmitPlan,
  prependPriorPlanIfPresent,
  formatPriorPlanSystemBlock,
  stripPlanBlock,
} from "../plan-emit";

beforeEach(() => {
  captureSend.mockReset();
  sendThrows = null;
});

describe("extractPlanBlock", () => {
  it("parses a well-formed <plan> block", () => {
    const r = extractPlanBlock(
      `<plan>{"summary":"Add guard","steps":["read","guard"],"files":["a.ts"]}</plan>`,
    );
    expect(r).toEqual({ summary: "Add guard", steps: ["read", "guard"], files: ["a.ts"] });
  });
  it("returns null when no block / malformed json", () => {
    expect(extractPlanBlock("just reasoning")).toBeNull();
    expect(extractPlanBlock("<plan>{not json}</plan>")).toBeNull();
  });
  it("clamps oversized arrays to schema caps", () => {
    const steps = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const r = extractPlanBlock(`<plan>${JSON.stringify({ summary: "x", steps, files })}</plan>`)!;
    expect(r.steps.length).toBe(8);
    expect(r.files.length).toBe(20);
  });
});

describe("maybeEmitPlan", () => {
  const okPlan = `<plan>{"summary":"s","steps":["a"],"files":["x.ts"]}</plan>`;

  it("emits once on the first text block and strips the block from residual", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: `${okPlan}\nnow exploring`,
      slug: "engineer",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ summary: "s", steps: ["a"], files: ["x.ts"] });
    expect(st.emitted).toBe(true);
    expect(r.residualText.includes("<plan>")).toBe(false);
    expect(r.residualText.trim()).toBe("now exploring");
  });

  it("does NOT emit twice", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: true };
    const r = await maybeEmitPlan({
      text: okPlan,
      slug: "engineer",
      isFirstTextBlock: false,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(r.residualText).toBe(okPlan);
  });

  it("does NOT emit for non-allowlisted agents (qa)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    await maybeEmitPlan({
      text: okPlan,
      slug: "qa",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits for operator slug (2026-05-21 widening)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: okPlan,
      slug: "operator",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(st.emitted).toBe(true);
    expect(r.residualText.includes("<plan>")).toBe(false);
  });

  it("operator emit does NOT fire plan-critic event (cto-only)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    await maybeEmitPlan({
      text: okPlan,
      slug: "operator",
      isFirstTextBlock: true,
      state: st,
      emit,
      run_id: "run-op",
      tenant_id: "tenant-op",
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(captureSend).not.toHaveBeenCalled();
  });

  it("only attempts on the first text block", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    await maybeEmitPlan({
      text: okPlan,
      slug: "engineer",
      isFirstTextBlock: false,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("malformed plan on first block → no emit, residual unchanged, state not latched", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: "<plan>{bad}</plan> rest",
      slug: "engineer",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(st.emitted).toBe(false);
    expect(r.residualText).toBe("<plan>{bad}</plan> rest");
  });

  it("plan-critic event fires for engineer when run_id + tenant_id provided", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    await maybeEmitPlan({
      text: okPlan,
      slug: "engineer",
      isFirstTextBlock: true,
      state: st,
      emit,
      run_id: "run-aaa",
      tenant_id: "tenant-xxx",
    });
    expect(captureSend).toHaveBeenCalledTimes(1);
    const sent = captureSend.mock.calls[0][0] as {
      name: string;
      data: { run_id: string; tenant_id: string; agent_slug: string; plan: unknown };
    };
    expect(sent.name).toBe("agent.plan-critic-needed");
    expect(sent.data.run_id).toBe("run-aaa");
    expect(sent.data.tenant_id).toBe("tenant-xxx");
    expect(sent.data.agent_slug).toBe("engineer");
    expect(sent.data.plan).toEqual({ summary: "s", steps: ["a"], files: ["x.ts"] });
  });

  it("plan-critic event does NOT fire when run_id / tenant_id are missing", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    await maybeEmitPlan({
      text: okPlan,
      slug: "engineer",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(captureSend).not.toHaveBeenCalled();
  });

  it("plan-critic event throws → maybeEmitPlan still returns successfully (best-effort)", async () => {
    sendThrows = new Error("inngest queue down");
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: okPlan,
      slug: "engineer",
      isFirstTextBlock: true,
      state: st,
      emit,
      run_id: "run-bbb",
      tenant_id: "tenant-yyy",
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(st.emitted).toBe(true);
    expect(captureSend).toHaveBeenCalledTimes(1);
    expect(r.residualText.includes("<plan>")).toBe(false);
  });
});

describe("isEmptyPlan", () => {
  it("an all-empty body is empty", () => {
    expect(isEmptyPlan({ summary: "", steps: [], files: [] })).toBe(true);
  });
  it("whitespace-only summary + whitespace-only steps are empty", () => {
    expect(isEmptyPlan({ summary: "   ", steps: ["  ", "\n"], files: [] })).toBe(
      true,
    );
  });
  it("a files-only body is empty (a touch-list is a prediction, not a plan)", () => {
    expect(isEmptyPlan({ summary: "", steps: [], files: ["a.ts"] })).toBe(true);
  });
  it("real steps make it non-empty", () => {
    expect(isEmptyPlan({ summary: "", steps: ["read the file"], files: [] })).toBe(
      false,
    );
  });
  it("a summary alone makes it non-empty (real direction, no step list)", () => {
    expect(isEmptyPlan({ summary: "Ship the fix", steps: [], files: [] })).toBe(
      false,
    );
  });
  it("classify alone makes it non-empty (operator tier floor + policy gate read it)", () => {
    expect(
      isEmptyPlan({
        classify: { tier: "tier3", confidence: 0.9, evidence_needed: [] },
        summary: "",
        steps: [],
        files: [],
      }),
    ).toBe(false);
  });
});

describe("maybeEmitPlan — steps present vs absent", () => {
  it("an agent that emits steps renders them (emit called with the real step list)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: `<plan>{"summary":"Fix the ranking","steps":["read plan-emit.ts","add the guard","test"],"files":["plan-emit.ts"]}</plan>\nStarting.`,
      slug: "operator",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toEqual({
      classify: undefined,
      summary: "Fix the ranking",
      steps: ["read plan-emit.ts", "add the guard", "test"],
      files: ["plan-emit.ts"],
    });
    expect(st.emitted).toBe(true);
    expect(r.residualText).toBe("Starting.");
  });

  it("an agent that emits NO steps renders NO row (<plan>{}</plan> → zero emits)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const r = await maybeEmitPlan({
      text: `<plan>{}</plan>\nHere is the answer.`,
      slug: "operator",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(st.emitted).toBe(false);
    expect(r.residualText).toBe("Here is the answer.");
    expect(r.residualText.includes("<plan>")).toBe(false);
  });

  it("an explicitly-empty step list also renders NO row", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const r = await maybeEmitPlan({
      text: `<plan>{"summary":"","steps":[],"files":[]}</plan>Answer.`,
      slug: "operator",
      isFirstTextBlock: true,
      state: { emitted: false },
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(r.residualText).toBe("Answer.");
  });

  it("an empty engineer plan does NOT fire the (paid) plan-critic lane", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await maybeEmitPlan({
      text: `<plan>{}</plan>Answer.`,
      slug: "engineer",
      isFirstTextBlock: true,
      state: { emitted: false },
      emit,
      run_id: "run-empty",
      tenant_id: "t1",
    });
    expect(emit).not.toHaveBeenCalled();
    expect(captureSend).not.toHaveBeenCalled();
  });

  it("a files-only plan renders NO row (no summary, no steps)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await maybeEmitPlan({
      text: `<plan>{"files":["a.ts","b.ts"]}</plan>Answer.`,
      slug: "operator",
      isFirstTextBlock: true,
      state: { emitted: false },
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("an operator classify-only plan STILL emits (tier floor + policy gate depend on the row)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await maybeEmitPlan({
      text: `<plan>{"classify":{"tier":"tier3","confidence":0.8,"evidence_needed":[]},"summary":"","steps":[]}</plan>Answer.`,
      slug: "operator",
      isFirstTextBlock: true,
      state: { emitted: false },
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].classify).toEqual({
      tier: "tier3",
      confidence: 0.8,
      evidence_needed: [],
    });
  });
});

type StubResult = {
  data: { body: unknown } | null;
  error: { message: string } | null;
};

function mkStubSb(result: StubResult) {
  const chain: Record<string, unknown> = {};
  const stubFn = (..._args: unknown[]) => chain;
  chain.select = stubFn;
  chain.eq = stubFn;
  chain.order = stubFn;
  chain.limit = stubFn;
  chain.maybeSingle = async () => result;
  return { from: (_t: string) => chain } as never;
}

describe("prependPriorPlanIfPresent", () => {
  it("returns null for non-allowlisted slug (qa)", async () => {
    const sb = mkStubSb({
      data: { body: { summary: "should never read" } },
      error: null,
    });
    const r = await prependPriorPlanIfPresent({
      slug: "qa",
      runId: "run-1",
      sb,
    });
    expect(r).toBeNull();
  });

  it("returns null when no prior plan exists for the run", async () => {
    const sb = mkStubSb({ data: null, error: null });
    const r = await prependPriorPlanIfPresent({
      slug: "operator",
      runId: "run-1",
      sb,
    });
    expect(r).toBeNull();
  });

  it("returns null when DB read errors (fail-safe)", async () => {
    const sb = mkStubSb({
      data: null,
      error: { message: "transient db blip" },
    });
    const r = await prependPriorPlanIfPresent({
      slug: "operator",
      runId: "run-1",
      sb,
    });
    expect(r).toBeNull();
  });

  it("formats prior plan as a <prior_plan> system block on happy path", async () => {
    const sb = mkStubSb({
      data: {
        body: {
          classify: { tier: "tier3", confidence: 0.85, evidence_needed: [] },
          summary: "investigate landing",
          steps: ["fetch DOM", "handoff to cto"],
          files: [],
        },
      },
      error: null,
    });
    const r = await prependPriorPlanIfPresent({
      slug: "operator",
      runId: "run-1",
      sb,
    });
    expect(r).toMatch(/<prior_plan>/);
    expect(r).toMatch(/<\/prior_plan>/);
    expect(r).toMatch(/tier3/);
    expect(r).toMatch(/Keep using/);
    expect(r).toMatch(/Do NOT re-emit/);
  });

  it("works for engineer slug too (not operator-only)", async () => {
    const sb = mkStubSb({
      data: { body: { summary: "cto plan", steps: ["a"], files: [] } },
      error: null,
    });
    const r = await prependPriorPlanIfPresent({
      slug: "engineer",
      runId: "run-1",
      sb,
    });
    expect(r).not.toBeNull();
    expect(r).toMatch(/cto plan/);
  });

  it("redacts PII before injecting (uses scrubQueryForCapture under the hood)", async () => {
    const sb = mkStubSb({
      data: {
        body: {
          summary: "user complained about charge from alice@example.com",
          steps: ["check stripe"],
          files: [],
        },
      },
      error: null,
    });
    const r = await prependPriorPlanIfPresent({
      slug: "operator",
      runId: "run-1",
      sb,
    });
    expect(r).not.toBeNull();
    expect(r).not.toMatch(/alice@example\.com/);
  });
});

describe("formatPriorPlanSystemBlock", () => {
  it("emits opening + closing tags", () => {
    const s = formatPriorPlanSystemBlock({ summary: "x" });
    expect(s.startsWith("<prior_plan>")).toBe(true);
    expect(s.endsWith("</prior_plan>")).toBe(true);
  });

  it("truncates at 8KB with marker", () => {
    const big = { summary: "x".repeat(20000) };
    const s = formatPriorPlanSystemBlock(big);
    expect(s).toMatch(/truncated/);
    expect(s.length).toBeLessThan(8500);
  });

  it("returns empty string on JSON-serialization failure (circular ref)", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatPriorPlanSystemBlock(circular)).toBe("");
  });
});

describe("stripPlanBlock", () => {
  it("strips a leading <plan>...</plan> block on an eligible slug (operator)", () => {
    const input = `<plan>{"summary":"x","steps":[],"files":[]}</plan>\nThe actual answer.`;
    expect(stripPlanBlock(input, "operator")).toBe("The actual answer.");
  });

  it("strips a leading <plan>...</plan> block on an eligible slug (engineer)", () => {
    const input = `<plan>{"summary":"x","steps":[],"files":[]}</plan>\nAnswer body.`;
    expect(stripPlanBlock(input, "engineer")).toBe("Answer body.");
  });

  it("passthrough on a non-eligible slug (does NOT strip)", () => {
    const input = `<plan>{"summary":"x","steps":[],"files":[]}</plan>\nfoo`;
    expect(stripPlanBlock(input, "ads-manager")).toBe(input);
    expect(stripPlanBlock(input, "qa")).toBe(input);
    expect(stripPlanBlock(input, "")).toBe(input);
  });

  it("a literal <plan> inside a NON-plan agent's prose survives unstripped", () => {
    const prose =
      "<plan> is the tag Cursor uses. Here is how I'd sequence the migration.";
    expect(stripPlanBlock(prose, "support-lead")).toBe(prose);
    expect(stripPlanBlock(prose, "pm")).toBe(prose);
    expect(stripPlanBlock(prose, "research")).toBe(prose);
    expect(stripPlanBlock(prose, "growth-lead")).toBe(prose);
  });

  it("maybeEmitPlan is a full passthrough for a non-plan slug (no emit, text untouched)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const st = { emitted: false };
    const text = `<plan>{"summary":"s","steps":["a"],"files":[]}</plan>\nbody`;
    const r = await maybeEmitPlan({
      text,
      slug: "support-lead",
      isFirstTextBlock: true,
      state: st,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(st.emitted).toBe(false);
    expect(r.residualText).toBe(text);
  });

  it("is idempotent — strip(strip(x)) === strip(x) for eligible slug", () => {
    const input = `<plan>{"summary":"x","steps":[],"files":[]}</plan>\nAnswer.`;
    const once = stripPlanBlock(input, "operator");
    const twice = stripPlanBlock(once, "operator");
    expect(twice).toBe(once);
    expect(twice).toBe("Answer.");
  });

  it("handles leading whitespace + trailing answer (real prod-shape input)", () => {
    const input = ` <plan>\n{\n  "classify": {\n    "tier": "tier1",\n    "confidence": 0.9\n  },\n  "summary": "Read the operator DB catalog",\n  "steps": ["Call operator_db__catalog"],\n  "files": []\n}\n</plan>\nThe catalog returned but was too large to fit in the model budget.`;
    const out = stripPlanBlock(input, "operator");
    expect(out).not.toContain("<plan>");
    expect(out).not.toContain("</plan>");
    expect(out).toContain("The catalog returned but was too large to fit in the model budget.");
  });

  it("returns the input unchanged when no <plan> block is present (eligible slug, no-op case)", () => {
    expect(stripPlanBlock("Just a plain answer.", "operator")).toBe("Just a plain answer.");
    expect(stripPlanBlock("", "operator")).toBe("");
  });

  it("strips only the FIRST <plan>...</plan> block (if a second leaks, leave it for grep tests to catch — never silently coalesce)", () => {
    const input = `<plan>{"summary":"a","steps":[],"files":[]}</plan>X<plan>{"summary":"b","steps":[],"files":[]}</plan>Y`;
    const out = stripPlanBlock(input, "operator");
    expect(out).toContain("<plan>");
    expect(out).toMatch(/^X/);
  });

  it("does NOT strip a <plan> tag mid-text — only strips when the envelope is a leading block (anchor precondition)", () => {
    const input = `Here's an example of the contract:\n\n<plan>{"summary":"x","steps":[],"files":[]}</plan>\n\nDoes that make sense?`;
    expect(stripPlanBlock(input, "operator")).toBe(input);
  });
});
