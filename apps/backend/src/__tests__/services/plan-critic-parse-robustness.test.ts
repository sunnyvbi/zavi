
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPlanCritic } from "@/services/critic/plan-critic";

let mockResponse: unknown = null;

vi.mock("@/services/anthropic", async () => {
  const actual = await vi.importActual<typeof import("@/services/anthropic")>(
    "@/services/anthropic",
  );
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        create: async () => mockResponse,
      },
    }),
  };
});

vi.mock("@/services/openai", async () => {
  const actual = await vi.importActual<typeof import("@/services/openai")>(
    "@/services/openai",
  );
  return { ...actual, getOpenAi: () => null };
});

beforeEach(() => {
  mockResponse = null;
});

const fakePlan = {
  summary: "Add a null-guard to fooBar()",
  steps: ["read foo.ts", "add guard"],
  files: ["apps/backend/src/foo.ts"],
};

function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 80, output_tokens: 40 },
  };
}

async function run() {
  return runPlanCritic({
    plan: fakePlan,
    task_description: "Add a null-guard to fooBar",
    context_summary: "nothing else relevant",
    stage_context: "Stage 3.",
  });
}

describe("plan-critic parse robustness (FIX 1 smoke)", () => {
  it("fenced ```json wrapped JSON now parses ok", async () => {
    mockResponse = textResponse(
      '```json\n{"verdict":"pass","findings":[]}\n```',
    );
    const v = await run();
    expect(v.status).toBe("ok");
    expect(v.verdict).toBe("pass");
  });

  it("over-cap finding problem/fix clamped → lane returns ok (not unavailable)", async () => {
    mockResponse = textResponse(
      JSON.stringify({
        verdict: "fail",
        findings: [
          {
            severity: "P1",
            location: "files[0]",
            problem: "p".repeat(2000),
            fix: "f".repeat(2000),
          },
        ],
      }),
    );
    const v = await run();
    expect(v.status).toBe("ok");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0].problem.length).toBeLessThanOrEqual(1500);
  });

  it("genuinely-malformed garbage still → unavailable", async () => {
    mockResponse = textResponse("no JSON here, sorry");
    const v = await run();
    expect(v.status).toBe("unavailable");
    expect(v.error).toBe("malformed_json");
  });
});
