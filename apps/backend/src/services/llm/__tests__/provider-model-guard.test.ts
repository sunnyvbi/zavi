import { describe, it, expect } from "vitest";
import {
  assertModelMatchesProvider,
  isAnthropicModel,
} from "@/services/llm/models";

describe("isAnthropicModel", () => {
  it("recognizes claude ids (any case / separator)", () => {
    expect(isAnthropicModel("claude-opus-4-7")).toBe(true);
    expect(isAnthropicModel("claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicModel("  claude-haiku-4-5-20251001 ")).toBe(true);
  });
  it("rejects non-claude ids", () => {
    expect(isAnthropicModel("gpt-5.5")).toBe(false);
    expect(isAnthropicModel("o3")).toBe(false);
    expect(isAnthropicModel("")).toBe(false);
  });
});

describe("assertModelMatchesProvider", () => {
  it("passes when openai provider has a non-claude model", () => {
    expect(() => assertModelMatchesProvider("openai", "gpt-5.5")).not.toThrow();
  });
  it("passes when anthropic provider has a claude model", () => {
    expect(() =>
      assertModelMatchesProvider("anthropic", "claude-opus-4-7"),
    ).not.toThrow();
  });
  it("THROWS on the real footgun: openai provider + claude model", () => {
    expect(() =>
      assertModelMatchesProvider("openai", "claude-opus-4-7"),
    ).toThrowError(/provider="openai".*claude-opus-4-7.*Anthropic/s);
  });
  it("throws on anthropic provider + non-claude model", () => {
    expect(() =>
      assertModelMatchesProvider("anthropic", "gpt-5.5"),
    ).toThrowError(/provider="anthropic".*not.*Claude/s);
  });
  it("throws on an empty model", () => {
    expect(() => assertModelMatchesProvider("openai", "")).toThrowError(
      /model is empty/,
    );
  });
  it("passes when bedrock provider has a known Bedrock (Qwen3) model", () => {
    expect(() =>
      assertModelMatchesProvider("bedrock", "qwen.qwen3-next-80b-a3b-instruct"),
    ).not.toThrow();
  });
  it("passes when bedrock provider has GLM-5 (Slice 4 allow-list)", () => {
    expect(() =>
      assertModelMatchesProvider("bedrock", "zai.glm-5"),
    ).not.toThrow();
  });
  it("THROWS on the bedrock footgun: bedrock provider + claude model", () => {
    expect(() =>
      assertModelMatchesProvider("bedrock", "claude-opus-4-7"),
    ).toThrowError(/provider="bedrock".*claude-opus-4-7.*Anthropic/s);
  });
  it("THROWS on bedrock + a non-bedrock id (e.g. an OpenAI id) before the network call", () => {
    expect(() =>
      assertModelMatchesProvider("bedrock", "gpt-5.5"),
    ).toThrowError(/provider="bedrock".*gpt-5\.5.*not a known Bedrock model id/s);
  });
  it("passes when fireworks provider has GLM-5.2", () => {
    expect(() =>
      assertModelMatchesProvider("fireworks", "accounts/fireworks/models/glm-5p2"),
    ).not.toThrow();
  });
  it("THROWS on fireworks + a non-fireworks id before the network call", () => {
    expect(() =>
      assertModelMatchesProvider("fireworks", "gpt-5.5"),
    ).toThrowError(
      /provider="fireworks".*gpt-5\.5.*not a known Fireworks model id/s,
    );
  });
});
