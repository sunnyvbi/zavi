
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODELS,
  MODEL_CAPABILITIES,
  assertModelMatchesProvider,
  modelSuppressesStructuredOutput,
} from "../models";

describe("modelSuppressesStructuredOutput", () => {
  it("is FALSE for GLM-5.2 — the vendor restriction was verified gone 2026-07-28", () => {
    expect(modelSuppressesStructuredOutput(MODELS.fireworks.glm52)).toBe(false);
  });

  it("is FALSE for Kimi K3 — verified live, it does not need the workaround", () => {
    expect(modelSuppressesStructuredOutput(MODELS.fireworks.kimiK3)).toBe(false);
  });

  it("is FALSE for every registered model — nothing needs the workaround today", () => {
    for (const [id, cap] of Object.entries(MODEL_CAPABILITIES)) {
      expect(cap.suppressStructuredOutput, `${id} should not suppress`).toBe(false);
    }
  });

  it("defaults to FALSE for an unknown, non-curated id", () => {
    expect(modelSuppressesStructuredOutput("some-unregistered-model")).toBe(false);
  });

  it("ACTUALLY THROWS when a curated id loses its capability entry", () => {
    const id = MODELS.fireworks.kimiK3;
    const saved = MODEL_CAPABILITIES[id];
    try {
      delete MODEL_CAPABILITIES[id];
      expect(() => modelSuppressesStructuredOutput(id, "fireworks")).toThrow(
        /no MODEL_CAPABILITIES entry/,
      );
      expect(modelSuppressesStructuredOutput(id)).toBe(false);
    } finally {
      MODEL_CAPABILITIES[id] = saved;
    }
    expect(MODEL_CAPABILITIES[id]).toEqual(saved);
  });

  it("does NOT throw for an id that was never registered in MODELS.fireworks", () => {
    expect(() =>
      modelSuppressesStructuredOutput(
        "accounts/fireworks/models/not-registered",
        "fireworks",
      ),
    ).not.toThrow();
  });

  it("every curated bedrock + fireworks id has a capability entry", () => {
    for (const id of Object.values(MODELS.fireworks)) {
      expect(MODEL_CAPABILITIES[id], `MODELS.fireworks "${id}"`).toBeDefined();
    }
    for (const id of Object.values(MODELS.bedrock)) {
      expect(MODEL_CAPABILITIES[id], `MODELS.bedrock "${id}"`).toBeDefined();
    }
  });
});

describe("OpenRouter: anthropic/* cannot take the envelope as response_format", () => {
  const spec = () =>
    ({
      systemPrompt: "s",
      userPrompt: "u",
      model: "x",
      maxTurns: 1,
      tools: [],
      resume: null,
      abort: new AbortController(),
      dispatchTool: async () => ({ is_error: false, content: "", ms: 0 }),
      onEvent: () => {},
      outputJsonSchema: {
        type: "json_schema" as const,
        schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
    }) as never;

  it("anthropic/* on openrouter suppresses; openai/gpt-5.5 on openrouter does not", () => {
    expect(modelSuppressesStructuredOutput("anthropic/claude-sonnet-4.6", "openrouter")).toBe(true);
    expect(modelSuppressesStructuredOutput("openai/gpt-5.5", "openrouter")).toBe(false);
  });

  it("the built agent has no outputType for anthropic/*, keeps it for openai/gpt-5.5", async () => {
    const { buildOpenAiAgent } = await import("../../agents/engine/openai-engine");
    const a = buildOpenAiAgent(spec(), undefined, modelSuppressesStructuredOutput("anthropic/claude-sonnet-4.6", "openrouter"));
    const g = buildOpenAiAgent(spec(), undefined, modelSuppressesStructuredOutput("openai/gpt-5.5", "openrouter"));
    expect((a as unknown as { outputType: unknown }).outputType).toBe("text");
    expect((g as unknown as { outputType: unknown }).outputType).toMatchObject({ type: "json_schema" });
  });
});

describe("Kimi K3 registration", () => {
  it("passes the Fireworks provider/model guard", () => {
    expect(() =>
      assertModelMatchesProvider("fireworks", MODELS.fireworks.kimiK3),
    ).not.toThrow();
  });

  it("still rejects an unregistered Fireworks id", () => {
    expect(() =>
      assertModelMatchesProvider("fireworks", "accounts/fireworks/models/made-up"),
    ).toThrow(/not a\s+known Fireworks model id/);
  });

  it("still rejects a Claude id on the fireworks provider", () => {
    expect(() =>
      assertModelMatchesProvider("fireworks", MODELS.anthropic.opus),
    ).toThrow(/Anthropic \(Claude\) model/);
  });

  it("declares 1M context, tool-use and a reasoning trace", () => {
    const cap = MODEL_CAPABILITIES[MODELS.fireworks.kimiK3];
    expect(cap).toBeDefined();
    expect(cap.contextLimit).toBe(1_000_000);
    expect(cap.supportsToolUse).toBe(true);
    expect(cap.reasoning).toBe(true);
  });
});

describe("engine call site (source pin)", () => {
  const engineSrc = readFileSync(
    join(__dirname, "../../agents/engine/openai-engine.ts"),
    "utf8",
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("Fireworks engine derives suppressOutputType per-model, never hardcodes true", () => {
    expect(engineSrc).toMatch(
      /buildOpenAiAgent\(\s*spec,\s*model,\s*modelSuppressesStructuredOutput\(\s*spec\.model,\s*"fireworks",?\s*\)/,
    );
    expect(engineSrc).not.toMatch(/buildOpenAiAgent\(spec,\s*model,\s*true\)/);
  });

  it("OpenRouter engine consults the per-model capability with provider openrouter", () => {
    expect(engineSrc).toMatch(
      /buildOpenAiAgent\(\s*spec,\s*model,\s*modelSuppressesStructuredOutput\(\s*spec\.model,\s*"openrouter",?\s*\)/,
    );
  });

  it("Bedrock engine still passes NO third arg (it never had the restriction)", () => {
    expect(engineSrc).toMatch(/const agent = buildOpenAiAgent\(spec, model\);/);
  });
});
