import { describe, it, expect } from "vitest";
import {
  MODELS,
  MODEL_CAPABILITIES,
  getModelCapabilities,
  isFixedTemperatureModel,
} from "@/services/llm/models";

describe("model capabilities (Goose ModelConfig mining — Copy 1)", () => {
  it("every id in MODELS has a capability entry", () => {
    const ids = [
      ...Object.values(MODELS.anthropic),
      ...Object.values(MODELS.openai),
    ];
    for (const id of ids) {
      expect(MODEL_CAPABILITIES[id], `missing caps for ${id}`).toBeDefined();
    }
  });

  it("getModelCapabilities returns null for an unknown id (not an error)", () => {
    expect(getModelCapabilities("totally-made-up-model")).toBeNull();
  });

  it("the OpenAI flagship is a reasoning (fixed-temperature) model", () => {
    expect(getModelCapabilities(MODELS.openai.flagship)?.reasoning).toBe(true);
    expect(isFixedTemperatureModel(MODELS.openai.flagship)).toBe(true);
  });

  it("Opus/Sonnet 5.5 reject sampling params; Haiku 4.5 does not", () => {
    expect(isFixedTemperatureModel(MODELS.anthropic.opus)).toBe(true);
    expect(isFixedTemperatureModel(MODELS.anthropic.sonnet)).toBe(true);
    expect(isFixedTemperatureModel(MODELS.anthropic.haiku)).toBe(false);
  });

  it("falls back to a regex for ids not in the table", () => {
    expect(isFixedTemperatureModel("gpt-5-turbo-2099")).toBe(true);
    expect(isFixedTemperatureModel("o1-preview")).toBe(true);
    expect(isFixedTemperatureModel("o3-mini")).toBe(true);
    expect(isFixedTemperatureModel("gpt-4o")).toBe(false);
    expect(isFixedTemperatureModel("")).toBe(false);
  });

  it("classifies UNRELEASED o-series generations as fixed-temperature", () => {
    expect(isFixedTemperatureModel("o4-mini")).toBe(true);
    expect(isFixedTemperatureModel("o5")).toBe(true);
    expect(isFixedTemperatureModel("o9-preview")).toBe(true);
    expect(isFixedTemperatureModel("gpt-4o-mini")).toBe(false);
    expect(isFixedTemperatureModel("omni-model")).toBe(false);
  });

  it("trims whitespace before lookup", () => {
    expect(getModelCapabilities(`  ${MODELS.anthropic.opus}  `)).not.toBeNull();
  });
});

describe("withoutRejectedSampling (aux-call chokepoint)", () => {
  it("drops temperature/top_p/top_k on the 5.5 models, keeps them on Haiku", async () => {
    const { withoutRejectedSampling } = await import("@/services/anthropic");
    const base = { max_tokens: 10, messages: [{ role: "user" as const, content: "x" }], temperature: 0, top_p: 0.9, top_k: 5 };
    for (const model of [MODELS.anthropic.opus, MODELS.anthropic.sonnet]) {
      const out = withoutRejectedSampling({ ...base, model });
      expect(out).not.toHaveProperty("temperature");
      expect(out).not.toHaveProperty("top_p");
      expect(out).not.toHaveProperty("top_k");
      expect(out.max_tokens).toBe(10);
    }
    expect(withoutRejectedSampling({ ...base, model: MODELS.anthropic.haiku })).toMatchObject({ temperature: 0, top_p: 0.9, top_k: 5 });
  });
});
