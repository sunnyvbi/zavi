import { describe, it, expect } from "vitest";
import { estimateEngineCostUsd, pricingVendorForModelId } from "@/services/llm/engine-cost";
import { MODELS } from "@/services/llm/models";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";

const usage1M: NormalizedUsage = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
} as NormalizedUsage;

describe("estimateEngineCostUsd (provider-aware)", () => {
  it("bedrock → Bedrock pricing (Qwen3 $0.15 in / $1.20 out), NOT Claude pricing", () => {
    const cost = estimateEngineCostUsd(
      "bedrock",
      MODELS.bedrock.qwen3Next80b,
      usage1M,
    );
    expect(cost).toBeCloseTo(1.35, 4);
  });

  it("bedrock unknown id → fallback (does NOT silently price as Claude)", () => {
    const cost = estimateEngineCostUsd("bedrock", "qwen.some-future-id", usage1M);
    expect(cost).toBeCloseTo(12, 4);
    expect(cost).toBeLessThan(18);
  });

  it("openai → OpenAI pricing (gpt-5.5 $5 in / $30 out)", () => {
    const cost = estimateEngineCostUsd("openai", MODELS.openai.flagship, usage1M);
    expect(cost).toBeCloseTo(35, 4);
  });

  it("fireworks → Fireworks pricing (GLM-5.2 $1.40 in / $4.40 out), NOT Claude pricing", () => {
    const cost = estimateEngineCostUsd(
      "fireworks",
      MODELS.fireworks.glm52,
      usage1M,
    );
    expect(cost).toBeCloseTo(5.8, 4);
  });

  it("codex → OpenAI pricing because the subscription endpoint serves gpt-5.x ids", () => {
    const cost = estimateEngineCostUsd("codex", MODELS.openai.flagship, usage1M);
    expect(cost).toBeCloseTo(35, 4);
  });

  it("bedrock → cached-read tokens are billed (conservative: folded into input, never dropped)", () => {
    const noCache = estimateEngineCostUsd("bedrock", MODELS.bedrock.qwen3Next80b, {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as NormalizedUsage);
    const withCache = estimateEngineCostUsd("bedrock", MODELS.bedrock.qwen3Next80b, {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    } as NormalizedUsage);
    expect(withCache).toBeGreaterThan(noCache);
    expect(withCache).toBeCloseTo(noCache * 2, 4);
  });

  it("anthropic → Anthropic pricing (much higher than bedrock for the same usage)", () => {
    const bedrock = estimateEngineCostUsd(
      "bedrock",
      MODELS.bedrock.qwen3Next80b,
      usage1M,
    );
    const anthropic = estimateEngineCostUsd(
      "anthropic",
      MODELS.anthropic.opus,
      usage1M,
    );
    expect(anthropic).toBeGreaterThan(bedrock * 5);
  });
});

describe("estimateEngineCostUsd — langchain meta-provider", () => {
  it("prices a gpt id on the OpenAI table, prefixed or bare", () => {
    expect(estimateEngineCostUsd("langchain", "gpt-5.5", usage1M)).toBeCloseTo(35, 4);
    expect(estimateEngineCostUsd("langchain", "openai:gpt-5.5", usage1M)).toBeCloseTo(35, 4);
  });

  it("prices a Claude id on the Anthropic table", () => {
    const direct = estimateEngineCostUsd("anthropic", MODELS.anthropic.sonnet, usage1M);
    expect(estimateEngineCostUsd("langchain", MODELS.anthropic.sonnet, usage1M)).toBeCloseTo(
      direct,
      6,
    );
    expect(
      estimateEngineCostUsd("langchain", `anthropic:${MODELS.anthropic.sonnet}`, usage1M),
    ).toBeCloseTo(direct, 6);
  });

  it("prices a Fireworks id on the Fireworks table", () => {
    const direct = estimateEngineCostUsd("fireworks", MODELS.fireworks.glm52, usage1M);
    expect(estimateEngineCostUsd("langchain", MODELS.fireworks.glm52, usage1M)).toBeCloseTo(
      direct,
      6,
    );
  });

  it("does NOT bill a cheap Fireworks id at the Claude MAX rate", () => {
    const maxPriceCost = 5 + 25;
    const fireworks = estimateEngineCostUsd("langchain", MODELS.fireworks.glm52, usage1M);
    expect(fireworks).toBeCloseTo(5.8, 4);
    expect(fireworks).toBeLessThan(maxPriceCost / 3);
  });
});

describe("pricingVendorForModelId", () => {
  it("maps by explicit prefix first", () => {
    expect(pricingVendorForModelId("anthropic:claude-sonnet-4-6")).toBe("anthropic");
    expect(pricingVendorForModelId("openai:gpt-5.5")).toBe("openai");
    expect(pricingVendorForModelId("fireworks:accounts/fireworks/models/glm-5p2")).toBe(
      "fireworks",
    );
  });

  it("infers from a bare id", () => {
    expect(pricingVendorForModelId("claude-opus-4-7")).toBe("anthropic");
    expect(pricingVendorForModelId("gpt-5.5")).toBe("openai");
    expect(pricingVendorForModelId("accounts/fireworks/models/kimi-k3")).toBe("fireworks");
  });

  it("follows the PRICE table, not the loader, for qwen.* (bedrock-priced)", () => {
    expect(pricingVendorForModelId(MODELS.bedrock.qwen3Next80b)).toBe("bedrock");
  });

  it("falls back to anthropic (loud MAX_PRICE + alert) on an unknown id", () => {
    expect(pricingVendorForModelId("some-unknown-model")).toBe("anthropic");
  });
});
