import { describe, it, expect } from "vitest";
import { OpenAIAgentEngine } from "../openai-engine";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolResult,
} from "../types";

const LIVE = process.env.PRAXIS_OPENAI_LIVE === "1";
const MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || "gpt-5.5";

(LIVE ? describe : describe.skip)("OpenAIAgentEngine live smoke", () => {
  it("streams text + reaches terminal with usage (no-tool task)", async () => {
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

    for await (const _ of new OpenAIAgentEngine().run(spec)) void _;

    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    const terminal = events.find((e) => e.type === "terminal");

    // eslint-disable-next-line no-console
    console.log("[live-smoke no-tool] text=%o terminal=%o", text, terminal);
    expect(text.length).toBeGreaterThan(0);
    expect(terminal).toBeDefined();
    expect((terminal as Extract<EngineEvent, { type: "terminal" }>).usage.output_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("fires a tool through dispatchTool (gate funnel observed)", async () => {
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

    for await (const _ of new OpenAIAgentEngine().run(spec)) void _;

    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    // eslint-disable-next-line no-console
    console.log(
      "[live-smoke tool] dispatched=%o text=%o",
      dispatched.map((d) => ({ name: d.tool_name, input: d.input })),
      text,
    );
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched[0].tool_name).toBe("weather__get_weather");
    expect(text.toLowerCase()).toContain("paris");
  }, 90_000);
});
