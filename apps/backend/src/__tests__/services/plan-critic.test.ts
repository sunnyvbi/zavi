import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPlanCritic, SYSTEM_PROMPT } from "@/services/critic/plan-critic";

const captureCall = vi.fn();
let mockResponse: unknown = null;
let mockThrow: Error | null = null;

vi.mock("@/services/anthropic", async () => {
  const actual = await vi.importActual<typeof import("@/services/anthropic")>(
    "@/services/anthropic",
  );
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        create: async (...args: unknown[]) => {
          captureCall(...args);
          if (mockThrow) throw mockThrow;
          return mockResponse;
        },
      },
    }),
  };
});

const captureOpenAiCall = vi.fn();
let openAiKeyed = false;
let mockOpenAiResponse: unknown = null;
let mockOpenAiThrow: Error | null = null;

vi.mock("@/services/openai", async () => {
  const actual = await vi.importActual<typeof import("@/services/openai")>(
    "@/services/openai",
  );
  return {
    ...actual,
    getOpenAi: () => {
      if (!openAiKeyed) return null;
      return {
        chat: {
          completions: {
            create: async (...args: unknown[]) => {
              captureOpenAiCall(...args);
              if (mockOpenAiThrow) throw mockOpenAiThrow;
              return mockOpenAiResponse;
            },
          },
        },
      };
    },
  };
});

beforeEach(() => {
  captureCall.mockReset();
  mockResponse = null;
  mockThrow = null;
  captureOpenAiCall.mockReset();
  openAiKeyed = false;
  mockOpenAiResponse = null;
  mockOpenAiThrow = null;
});

const fakePlan = {
  summary: "Add a null-guard to fooBar()",
  steps: ["read foo.ts", "add guard", "add test"],
  files: ["apps/backend/src/foo.ts", "apps/backend/src/__tests__/foo.test.ts"],
};

function textResponse(jsonStr: string) {
  return {
    content: [{ type: "text", text: jsonStr }],
    usage: { input_tokens: 80, output_tokens: 40 },
  };
}

function openAiResponse(jsonStr: string) {
  return {
    choices: [{ message: { content: jsonStr } }],
    usage: { prompt_tokens: 100, completion_tokens: 60 },
  };
}

describe("plan-critic — runPlanCritic", () => {
  it("Case 1 — clean plan → verdict pass, 0 findings, top_severity null", async () => {
    mockResponse = textResponse(
      JSON.stringify({ verdict: "pass", findings: [] }),
    );
    const v = await runPlanCritic({
      plan: fakePlan,
      task_description: "Add a null-guard to fooBar so it doesn't crash",
      context_summary: "Context: nothing else relevant.",
      stage_context: "Stage 2, ~10 customers, low risk.",
    });
    expect(v.status).toBe("ok");
    expect(v.verdict).toBe("pass");
    expect(v.top_severity).toBeNull();
    expect(v.findings).toEqual([]);
    expect(v.model).toBeTypeOf("string");
    expect(v.model.length).toBeGreaterThan(0);
    expect(v.cost_usd).toBeGreaterThan(0);
    expect(v.lanes?.anthropic.status).toBe("ok");
    expect(v.lanes?.openai.status).toBe("skipped");
  });

  it("Case 2 — wrong plan (P1 finding) → verdict fail, top_severity P1, reviewer stamped", async () => {
    mockResponse = textResponse(
      JSON.stringify({
        verdict: "fail",
        findings: [
          {
            severity: "P1",
            location: "files[0]",
            problem: "Plan deletes supabase/migrations/* — forbidden surface for engineer",
            fix: "Drop the migration-touching step; engineer cannot edit migrations",
          },
        ],
      }),
    );
    const v = await runPlanCritic({
      plan: {
        summary: "delete migrations/* to fix the bug",
        steps: ["rm -rf supabase/migrations/", "rebuild"],
        files: ["supabase/migrations/0001_init.sql"],
      },
      task_description: "Fix an off-by-one in fooBar",
      context_summary: "n/a",
      stage_context: "Stage 2, ~10 customers.",
    });
    expect(v.status).toBe("ok");
    expect(v.verdict).toBe("fail");
    expect(v.top_severity).toBe("P1");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0].reviewer).toBe("anthropic");
  });

  it("Case 3 — OpenAI lane skipped (no key) → anthropic-only verdict, lanes.openai.status='skipped'", async () => {
    mockResponse = textResponse(
      JSON.stringify({ verdict: "pass", findings: [] }),
    );
    const v = await runPlanCritic({
      plan: fakePlan,
      task_description: "trivial",
      context_summary: "",
      stage_context: "Stage 2",
    });
    expect(v.status).toBe("ok");
    expect(v.lanes?.openai.status).toBe("skipped");
    expect(v.lanes?.anthropic.status).toBe("ok");
    expect(captureOpenAiCall).not.toHaveBeenCalled();
  });

  it("Case 4 — both lanes fail → status unavailable, verdict pass (fail-open), no throw", async () => {
    mockThrow = new Error("anthropic dead");
    openAiKeyed = true;
    mockOpenAiThrow = new Error("openai dead");

    const v = await runPlanCritic({
      plan: fakePlan,
      task_description: "trivial",
      context_summary: "",
      stage_context: "Stage 2",
    });
    expect(v.status).toBe("unavailable");
    expect(v.verdict).toBe("pass");
    expect(v.findings).toEqual([]);
    expect(v.lanes?.anthropic.status).toBe("unavailable");
    expect(v.lanes?.openai.status).toBe("unavailable");
    expect(v.error).toMatch(/anthropic_error.*openai_error|openai_error.*anthropic_error/);
    expect(v.cost_usd).toBe(0);
  });

  it("Case 5 — schema-invalid output from anthropic, openai still ok → openai produces the verdict, anthropic unavailable", async () => {
    mockResponse = textResponse(
      JSON.stringify({ verdict: "maybe", findings: [] }),
    );
    openAiKeyed = true;
    mockOpenAiResponse = openAiResponse(
      JSON.stringify({
        verdict: "pass",
        findings: [
          {
            severity: "P2",
            location: "files[1]",
            problem: "minor",
            fix: "tweak",
          },
        ],
      }),
    );

    const v = await runPlanCritic({
      plan: fakePlan,
      task_description: "trivial",
      context_summary: "",
      stage_context: "Stage 2",
    });
    expect(v.status).toBe("ok");
    expect(v.lanes?.anthropic.status).toBe("unavailable");
    expect(v.lanes?.anthropic).toHaveProperty("error");
    expect(
      v.lanes?.anthropic.status === "unavailable" &&
        v.lanes.anthropic.error?.startsWith("schema_invalid:"),
    ).toBe(true);
    expect(v.lanes?.openai.status).toBe("ok");
    expect(v.verdict).toBe("pass");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0].reviewer).toBe("openai");
  });

  it("Case 6 — reviewer-stamp regression: model emits NO `reviewer` field, orchestrator stamps it post-parse", async () => {
    mockResponse = textResponse(
      JSON.stringify({
        verdict: "pass",
        findings: [
          {
            severity: "P3",
            location: "files[0]",
            problem: "nit",
            fix: "minor tweak",
          },
        ],
      }),
    );
    const v = await runPlanCritic({
      plan: fakePlan,
      task_description: "trivial",
      context_summary: "",
      stage_context: "Stage 2",
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0].reviewer).toBe("anthropic");

    const [callArg] = captureCall.mock.calls[0];
    const call = callArg as { system: string; messages: unknown[] };
    expect(call.system).toBe(SYSTEM_PROMPT);
  });
});
