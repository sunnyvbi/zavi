import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __resetCodexClientForTests } from "@/services/codex-subscription";
import {
  deepAgentDefaultLangChainModelId,
  deepAgentModelId,
  resolveDeepAgentModel,
} from "../resolve-model";

const ENV_KEYS = [
  "CODEX_ACCESS_TOKEN",
  "CODEX_ACCOUNT_ID",
  "DEEPAGENT_USE_CODEX",
  "DEEPAGENT_DEFAULT_MODEL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetCodexClientForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetCodexClientForTests();
});

describe("resolveDeepAgentModel", () => {
  it("passes through when CODEX_ACCESS_TOKEN unset", () => {
    expect(resolveDeepAgentModel("fireworks:accounts/fireworks/models/kimi-k3")).toBe(
      "fireworks:accounts/fireworks/models/kimi-k3",
    );
    expect(resolveDeepAgentModel("anthropic:claude-sonnet-4-6")).toBe(
      "anthropic:claude-sonnet-4-6",
    );
  });

  it("returns ChatOpenAI for fireworks when codex enabled", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.CODEX_ACCOUNT_ID = "acct-1";
    const m = resolveDeepAgentModel("fireworks:accounts/fireworks/models/kimi-k3");
    expect(typeof m).toBe("object");
    expect((m as { model?: string }).model).toBe("gpt-5.5");
  });

  it("returns ChatOpenAI for openai: ids when codex enabled", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.CODEX_ACCOUNT_ID = "acct-1";
    const m = resolveDeepAgentModel("openai:gpt-5.5");
    expect(typeof m).toBe("object");
    expect((m as { model?: string }).model).toBe("gpt-5.5");
  });

  it("keeps anthropic pin even when codex enabled", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(resolveDeepAgentModel("anthropic:claude-sonnet-4-6")).toBe(
      "anthropic:claude-sonnet-4-6",
    );
  });

  it("DEEPAGENT_USE_CODEX=0 disables codex routing", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.DEEPAGENT_USE_CODEX = "0";
    expect(resolveDeepAgentModel("fireworks:accounts/fireworks/models/kimi-k3")).toBe(
      "fireworks:accounts/fireworks/models/kimi-k3",
    );
  });
});

describe("deepAgentDefaultLangChainModelId", () => {
  it("defaults to fireworks kimi when codex off", () => {
    expect(deepAgentDefaultLangChainModelId()).toBe(
      "fireworks:accounts/fireworks/models/kimi-k3",
    );
  });

  it("defaults to openai gpt-5.5 when codex on", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(deepAgentDefaultLangChainModelId()).toBe("openai:gpt-5.5");
  });

  it("honors DEEPAGENT_DEFAULT_MODEL override", () => {
    process.env.DEEPAGENT_DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";
    expect(deepAgentDefaultLangChainModelId()).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("deepAgentModelId — codex by default", () => {
  it("routes the agent.md Claude default to Codex when the token is set", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(deepAgentModelId("claude-sonnet-4-6")).toBe("openai:gpt-5.5");
    expect(deepAgentModelId("claude-opus-4-7")).toBe("openai:gpt-5.5");
  });

  it("respects an EXPLICIT provider-prefixed pin", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(deepAgentModelId("anthropic:claude-opus-4-7")).toBe(
      "anthropic:claude-opus-4-7",
    );
  });

  it("respects a bare non-Claude id", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(deepAgentModelId("gpt-5.5")).toBe("openai:gpt-5.5");
    expect(deepAgentModelId("accounts/fireworks/models/glm-5p2")).toBe(
      "fireworks:accounts/fireworks/models/glm-5p2",
    );
  });

  it("keeps the agent's Claude model when codex is off or disabled", () => {
    expect(deepAgentModelId("claude-sonnet-4-6")).toBe("anthropic:claude-sonnet-4-6");
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.DEEPAGENT_USE_CODEX = "0";
    expect(deepAgentModelId("claude-sonnet-4-6")).toBe("anthropic:claude-sonnet-4-6");
  });

  it("DEEPAGENT_DEFAULT_MODEL outranks the codex default", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.DEEPAGENT_DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";
    expect(deepAgentModelId("claude-sonnet-4-6")).toBe("anthropic:claude-sonnet-4-6");
  });

  it("Studio (no agent model) still gets the codex default", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    expect(deepAgentModelId()).toBe(deepAgentDefaultLangChainModelId());
    expect(deepAgentModelId()).toBe("openai:gpt-5.5");
  });
});
