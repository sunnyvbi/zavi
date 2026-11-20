
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BedrockOpenAICompatAgentEngine } from "../openai-engine";
import type { AgentEngineRunSpec } from "../types";

function minimalSpec(model: string): AgentEngineRunSpec {
  return {
    systemPrompt: "you are a test agent",
    userPrompt: "hi",
    model,
    maxTurns: 4,
    tools: [],
    resume: null,
    abort: new AbortController(),
    dispatchTool: async () => ({ is_error: false, content: "{}", ms: 0 }),
    onEvent: () => {},
  };
}

describe("BedrockOpenAICompatAgentEngine (behavioral)", () => {
  const saved = {
    base: process.env.BEDROCK_OPENAI_BASE_URL,
    key: process.env.AWS_BEARER_TOKEN_BEDROCK,
  };
  beforeEach(() => {
    delete process.env.BEDROCK_OPENAI_BASE_URL;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  });
  afterEach(() => {
    if (saved.base === undefined) delete process.env.BEDROCK_OPENAI_BASE_URL;
    else process.env.BEDROCK_OPENAI_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = saved.key;
  });

  it("provider is 'bedrock'", () => {
    expect(new BedrockOpenAICompatAgentEngine().provider).toBe("bedrock");
  });

  it("fail-loud when AWS_BEARER_TOKEN_BEDROCK is unset (base URL is now per-model, not required)", async () => {
    const it = new BedrockOpenAICompatAgentEngine()
      .run(minimalSpec("qwen.qwen3-next-80b-a3b-instruct"))
      [Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(
      /AWS_BEARER_TOKEN_BEDROCK.*not.*set/s,
    );
  });

  it("fail-loud on a provider/model mismatch (bedrock + claude id) BEFORE any network call", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer";
    const it = new BedrockOpenAICompatAgentEngine()
      .run(minimalSpec("claude-opus-4-7"))
      [Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(
      /provider="bedrock".*claude-opus-4-7.*Anthropic/s,
    );
  });
});

const SRC = readFileSync(join(__dirname, "../openai-engine.ts"), "utf8");

function bedrockEngineBody(): string {
  const m = SRC.match(
    /export class BedrockOpenAICompatAgentEngine[\s\S]*?\n}/,
  );
  expect(m, "BedrockOpenAICompatAgentEngine body not found").toBeTruthy();
  return m![0];
}

describe("BedrockOpenAICompatAgentEngine (safety/statelessness contract)", () => {
  it("REUSES buildOpenAiAgent (Gate-3.0 inherited — no separate Agent construction)", () => {
    const body = bedrockEngineBody();
    expect(body).toMatch(/buildOpenAiAgent\(spec, model\)/);
  });

  it("drives the SHARED stream core in STATELESS mode (Chat Completions, no store/resume)", () => {
    const body = bedrockEngineBody();
    expect(body).toMatch(/streamOpenAICompatRun\(spec, agent, "stateless"\)/);
  });

  it("uses a PER-INSTANCE client wrapped in OpenAIChatCompletionsModel (NOT Responses)", () => {
    const body = bedrockEngineBody();
    expect(body).toMatch(/new OpenAI\(\{ apiKey, baseURL \}\)/);
    expect(body).toMatch(/new OpenAIChatCompletionsModel\(client, spec\.model\)/);
  });

  it("never touches the shared getOpenAi() singleton or a process-global client", () => {
    const body = bedrockEngineBody();
    expect(body).not.toMatch(/getOpenAi\(/);
    expect(body).not.toMatch(/setDefaultOpenAIClient/);
    expect(body).not.toMatch(/setOpenAIAPI/);
  });

  it("the 'stateless' terminal carries resume: null (transcript-flatten next turn)", () => {
    expect(SRC).toMatch(/\{ type: "terminal", resume: null, usage \}/);
  });

  it("asserts provider/model match for bedrock before constructing the client", () => {
    const body = bedrockEngineBody();
    const assertIdx = body.indexOf('assertModelMatchesProvider("bedrock"');
    const clientIdx = body.indexOf("new OpenAI(");
    expect(assertIdx).toBeGreaterThan(-1);
    expect(clientIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeLessThan(clientIdx);
  });
});
