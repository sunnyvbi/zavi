import { describe, expect, it } from "vitest";
import { applyDeepAgentProfile } from "../apply-profile";
import { CODEX_PROFILE } from "../profiles/codex";
import {
  profileIdFromLangChainModelId,
  resolveDeepAgentProfileId,
} from "../resolve-profile";

describe("resolveDeepAgentProfile", () => {
  it("maps anthropic ids to claude profile", () => {
    expect(profileIdFromLangChainModelId("anthropic:claude-sonnet-4-6")).toBe("claude");
    expect(profileIdFromLangChainModelId("claude-opus-4-7")).toBe("claude");
  });

  it("maps openai/gpt ids to codex profile", () => {
    expect(profileIdFromLangChainModelId("openai:gpt-5.5")).toBe("codex");
    expect(profileIdFromLangChainModelId("gpt-5.5")).toBe("codex");
  });

  it("maps fireworks kimi vs glm", () => {
    expect(
      profileIdFromLangChainModelId("fireworks:accounts/fireworks/models/kimi-k3"),
    ).toBe("fireworks-kimi");
    expect(
      profileIdFromLangChainModelId("fireworks:accounts/fireworks/models/glm-5p2"),
    ).toBe("fireworks-glm");
  });

  it("respects DEEPAGENT_PROMPT_PROFILE override", () => {
    const prev = process.env.DEEPAGENT_PROMPT_PROFILE;
    process.env.DEEPAGENT_PROMPT_PROFILE = "claude";
    expect(resolveDeepAgentProfileId("openai:gpt-5.5")).toBe("claude");
    if (prev === undefined) delete process.env.DEEPAGENT_PROMPT_PROFILE;
    else process.env.DEEPAGENT_PROMPT_PROFILE = prev;
  });
});

describe("applyDeepAgentProfile", () => {
  it("appends only model addendum when agent.md base is present", () => {
    const out = applyDeepAgentProfile("AGENT BASE", CODEX_PROFILE);
    expect(out).toContain("AGENT BASE");
    expect(out).toContain("CODEX / GPT-5 PROFILE");
    expect(out).not.toContain("You are Zavi, an AI growth operator");
  });

  it("includes harness overlay when base is empty (Studio)", () => {
    const out = applyDeepAgentProfile("", CODEX_PROFILE);
    expect(out).toContain("You are Zavi, an AI growth operator");
    expect(out).toContain("CODEX / GPT-5 PROFILE");
  });
});
