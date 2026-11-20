import { describe, it, expect } from "vitest";
import { OpenAIAgentEngine } from "../openai-engine";
import type { AgentEngineRunSpec, EngineEvent } from "../types";

const LIVE = process.env.PRAXIS_OPENAI_LIVE === "1";
const MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || "gpt-5.5";

const STRICT_ENVELOPE = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["rendered_markdown", "decision"],
    properties: {
      rendered_markdown: { type: "string" },
      decision: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "confidence", "blockers"],
        properties: {
          summary: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          blockers: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function runSpec(outputJsonSchema?: AgentEngineRunSpec["outputJsonSchema"]) {
  const events: EngineEvent[] = [];
  const spec: AgentEngineRunSpec = {
    systemPrompt:
      "You are a research agent. Produce a two-channel result: rendered_markdown (a short markdown summary) and a decision object with summary, confidence (low|medium|high), and blockers (array of strings).",
    userPrompt:
      "Question: should we ship feature X? Give a 2-sentence markdown summary and a decision with one blocker.",
    model: MODEL,
    maxTurns: 3,
    tools: [],
    resume: null,
    abort: new AbortController(),
    dispatchTool: async () => ({ is_error: false, content: "", ms: 0 }),
    onEvent: (e) => events.push(e),
    ...(outputJsonSchema ? { outputJsonSchema } : {}),
  };
  return { spec, events };
}

(LIVE ? describe : describe.skip)("gpt-5.5 strict structured-output spike", () => {
  it("CONFORMING normalized strict schema → valid JSON matching the schema", async () => {
    const { spec, events } = runSpec(STRICT_ENVELOPE);
    let err: Error | null = null;
    try {
      for await (const _ of new OpenAIAgentEngine().run(spec)) void _;
    } catch (e) {
      err = e as Error;
    }
    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    // eslint-disable-next-line no-console
    console.log("[strict-spike] err=%o raw=%o", err?.message, text.slice(0, 600));
    expect(err, "engine threw on strict structured output").toBeNull();
    const parsed = JSON.parse(text);
    expect(typeof parsed.rendered_markdown).toBe("string");
    expect(["low", "medium", "high"]).toContain(parsed.decision.confidence);
    expect(Array.isArray(parsed.decision.blockers)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[strict-spike] CONFORM OK — keys:", Object.keys(parsed), "decision:", Object.keys(parsed.decision));
  }, 60_000);

  it("NON-conforming schema (banned keywords) → tolerated, not a hard 400 (still produces output)", async () => {
    const bad = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 3, pattern: "^[A-Z]" },
        },
      },
    };
    const { spec, events } = runSpec(bad);
    let err: Error | null = null;
    try {
      for await (const _ of new OpenAIAgentEngine().run(spec)) void _;
    } catch (e) {
      err = e as Error;
    }
    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    // eslint-disable-next-line no-console
    console.log("[strict-spike] NON-CONFORM err=%o text=%o", err?.message?.slice(0, 300), text.slice(0, 200));
    expect(err).toBeNull();
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
