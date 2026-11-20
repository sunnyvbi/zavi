import { describe, it, expect } from "vitest";
import { resolveDepthModel } from "../depth-resolver";
import { MODELS } from "@/services/llm/models";

const SONNET = MODELS.anthropic.sonnet;
const OPUS = MODELS.anthropic.opus;

describe("resolveDepthModel (provider-neutral depth → model)", () => {
  it("anthropic: light ⇒ the agent base model, deep ⇒ opus (byte-identical to modelForTier)", () => {
    expect(resolveDepthModel("anthropic", "light", SONNET)).toBe(SONNET);
    expect(resolveDepthModel("anthropic", "deep", SONNET)).toBe(OPUS);
  });

  it("anthropic: an opus-base agent stays opus at BOTH levels (no escalation headroom)", () => {
    expect(resolveDepthModel("anthropic", "light", OPUS)).toBe(OPUS);
    expect(resolveDepthModel("anthropic", "deep", OPUS)).toBe(OPUS);
  });

  it("openai / codex: single served tier — light === deep", () => {
    expect(resolveDepthModel("openai", "light", SONNET)).toBe(MODELS.openai.flagship);
    expect(resolveDepthModel("openai", "deep", SONNET)).toBe(MODELS.openai.flagship);
    expect(resolveDepthModel("codex", "deep", SONNET)).toBe(MODELS.openai.flagship);
  });

  it("bedrock / fireworks: resolve to their served OSS model (seam is live + testable)", () => {
    expect(resolveDepthModel("bedrock", "light", SONNET)).toBe(MODELS.bedrock.qwen3Next80b);
    expect(resolveDepthModel("bedrock", "deep", SONNET)).toBe(MODELS.bedrock.qwen3Next80b);
    expect(resolveDepthModel("fireworks", "deep", SONNET)).toBe(MODELS.fireworks.glm52);
  });

  it("the anthropic anchor is IGNORED for non-anthropic providers (no policy rewrite on a provider switch)", () => {
    expect(resolveDepthModel("bedrock", "light", OPUS)).toBe(MODELS.bedrock.qwen3Next80b);
    expect(resolveDepthModel("fireworks", "light", OPUS)).toBe(MODELS.fireworks.glm52);
  });
});
