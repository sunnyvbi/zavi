
import { describe, it, expect } from "vitest";
import {
  bedrockRegionForModel,
  resolveBedrockBaseUrl,
  BEDROCK_MODEL_REGION,
} from "../openai-engine";
import { MODELS } from "@/services/llm/models";
import { assertModelMatchesProvider } from "@/services/llm/models";

describe("bedrockRegionForModel", () => {
  it("pins Qwen3 to us-west-2", () => {
    expect(bedrockRegionForModel(MODELS.bedrock.qwen3Next80b)).toBe("us-west-2");
  });
  it("pins the Llama judge to us-west-2", () => {
    expect(bedrockRegionForModel(MODELS.bedrock.judgeMistralLarge3)).toBe(
      "us-west-2",
    );
  });
  it("pins GLM-5 to us-east-1 (NOT us-west-2)", () => {
    expect(bedrockRegionForModel(MODELS.bedrock.glm5)).toBe("us-east-1");
  });
  it("falls back to us-west-2 for an unknown id", () => {
    expect(bedrockRegionForModel("some.unknown-model")).toBe("us-west-2");
  });
  it("trims whitespace before lookup", () => {
    expect(bedrockRegionForModel("  zai.glm-5  ")).toBe("us-east-1");
  });
  it("every model in MODELS.bedrock has a pinned region", () => {
    for (const id of Object.values(MODELS.bedrock)) {
      expect(BEDROCK_MODEL_REGION[id], `missing region for ${id}`).toBeTruthy();
    }
  });
});

describe("resolveBedrockBaseUrl", () => {
  it("derives the us-west-2 regional Mantle URL for Qwen (no env)", () => {
    expect(resolveBedrockBaseUrl(MODELS.bedrock.qwen3Next80b, {})).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/v1",
    );
  });

  it("derives the us-east-1 regional Mantle URL for GLM-5 (no env)", () => {
    expect(resolveBedrockBaseUrl(MODELS.bedrock.glm5, {})).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/v1",
    );
  });

  it("a cross-region model (GLM-5 us-east-1) NEVER inherits the us-west-2 global override", () => {
    const env = {
      BEDROCK_OPENAI_BASE_URL: "https://bedrock-mantle.us-west-2.api.aws/v1",
    } as NodeJS.ProcessEnv;
    expect(resolveBedrockBaseUrl(MODELS.bedrock.glm5, env)).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/v1",
    );
  });

  it("the legacy global override IS honored for a default-region (us-west-2) model", () => {
    const env = {
      BEDROCK_OPENAI_BASE_URL: "https://custom.example/openai/v1",
    } as NodeJS.ProcessEnv;
    expect(resolveBedrockBaseUrl(MODELS.bedrock.qwen3Next80b, env)).toBe(
      "https://custom.example/openai/v1",
    );
  });

  it("a per-region override wins for that region (BEDROCK_OPENAI_BASE_URL_US_EAST_1)", () => {
    const env = {
      BEDROCK_OPENAI_BASE_URL: "https://bedrock-mantle.us-west-2.api.aws/v1",
      BEDROCK_OPENAI_BASE_URL_US_EAST_1: "https://east.example/openai/v1",
    } as NodeJS.ProcessEnv;
    expect(resolveBedrockBaseUrl(MODELS.bedrock.glm5, env)).toBe(
      "https://east.example/openai/v1",
    );
  });

  it("per-region override does NOT leak across regions", () => {
    const env = {
      BEDROCK_OPENAI_BASE_URL_US_EAST_1: "https://east.example/openai/v1",
    } as NodeJS.ProcessEnv;
    expect(resolveBedrockBaseUrl(MODELS.bedrock.qwen3Next80b, env)).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/v1",
    );
  });

  it("trims a whitespace-only override and falls through to the derived URL", () => {
    const env = { BEDROCK_OPENAI_BASE_URL: "   " } as NodeJS.ProcessEnv;
    expect(resolveBedrockBaseUrl(MODELS.bedrock.qwen3Next80b, env)).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/v1",
    );
  });
});

describe("GLM-5 model registration (Slice 4)", () => {
  it("MODELS.bedrock.glm5 is the Mantle id zai.glm-5", () => {
    expect(MODELS.bedrock.glm5).toBe("zai.glm-5");
  });
  it("assertModelMatchesProvider accepts bedrock + zai.glm-5", () => {
    expect(() =>
      assertModelMatchesProvider("bedrock", MODELS.bedrock.glm5),
    ).not.toThrow();
  });
});
