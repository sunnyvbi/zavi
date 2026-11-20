import { describe, it, expect } from "vitest";
import {
  BedrockOpenAICompatAgentEngine,
  resolveBedrockBaseUrl,
} from "../openai-engine";
import { MODELS } from "@/services/llm/models";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolResult,
} from "../types";

const LIVE = process.env.PRAXIS_BEDROCK_LIVE === "1";
const MODEL = process.env.PRAXIS_BEDROCK_MODEL || MODELS.bedrock.qwen3Next80b;

(LIVE ? describe : describe.skip)("BedrockOpenAICompatAgentEngine live smoke", () => {
  it("streams text + reaches a STATELESS terminal (resume:null) with usage (no-tool task)", async () => {
    const events: EngineEvent[] = [];
    const spec: AgentEngineRunSpec = {
      systemPrompt: "You are a terse assistant. Answer in one short sentence.",
      userPrompt: "Say the single word: pong.",
      model: MODEL,
      maxTurns: 4,
      tools: [],
      resume: null,
      abort: new AbortController(),
      dispatchTool: async (): Promise<EngineToolResult> => ({
        is_error: false,
        content: "unused",
        ms: 0,
      }),
      onEvent: (e) => events.push(e),
    };

    for await (const _ of new BedrockOpenAICompatAgentEngine().run(spec)) void _;

    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    const terminal = events.find((e) => e.type === "terminal") as
      | Extract<EngineEvent, { type: "terminal" }>
      | undefined;

    // eslint-disable-next-line no-console
    console.log("[bedrock-smoke no-tool] text=%o terminal=%o", text, terminal);
    expect(text.length).toBeGreaterThan(0);
    expect(terminal).toBeDefined();
    expect(terminal!.resume).toBeNull();
    expect(terminal!.usage.output_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("fires a tool through dispatchTool (gate funnel observed) end to end", async () => {
    const events: EngineEvent[] = [];
    const dispatched: EngineToolCall[] = [];
    const spec: AgentEngineRunSpec = {
      systemPrompt:
        "You MUST call the get_weather tool to answer. Never guess weather.",
      userPrompt: "What is the weather in Paris? Call the tool.",
      model: MODEL,
      maxTurns: 6,
      tools: [
        {
          name: "weather__get_weather",
          description: "Get the current weather for a city.",
          jsonSchema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ],
      resume: null,
      abort: new AbortController(),
      dispatchTool: async (call): Promise<EngineToolResult> => {
        dispatched.push(call);
        return {
          is_error: false,
          content: JSON.stringify({ city: "Paris", tempC: 17, sky: "clear" }),
          ms: 3,
        };
      },
      onEvent: (e) => events.push(e),
    };

    for await (const _ of new BedrockOpenAICompatAgentEngine().run(spec)) void _;

    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    const toolEvents = events.filter((e) => e.type === "tool_call");
    // eslint-disable-next-line no-console
    console.log(
      "[bedrock-smoke tool] dispatched=%o toolEvents=%o text=%o",
      dispatched.map((d) => ({ name: d.tool_name, input: d.input })),
      toolEvents,
      text,
    );
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched[0].tool_name).toBe("weather__get_weather");
    expect(text.toLowerCase()).toContain("paris");
  }, 90_000);
});

describe("Bedrock live-smoke region resolution (GLM-5 case, no live call)", () => {
  it("GLM-5 resolves to the us-east-1 Mantle endpoint", () => {
    expect(resolveBedrockBaseUrl(MODELS.bedrock.glm5, {})).toContain(
      "us-east-1",
    );
  });
  it("Qwen3 resolves to the us-west-2 Mantle endpoint", () => {
    expect(resolveBedrockBaseUrl(MODELS.bedrock.qwen3Next80b, {})).toContain(
      "us-west-2",
    );
  });
});
