
import { describe, it, expect } from "vitest";
import { resolveLiveSdkFunnel } from "../sdk-funnel-route";
import type { Provider } from "@/services/llm/models";

const ALL_PROVIDERS: Provider[] = [
  "anthropic",
  "openai",
  "bedrock",
  "fireworks",
  "codex",
];

describe("resolveLiveSdkFunnel — operator security pin", () => {
  it("operator ALWAYS routes to inline_anthropic, across every provider × engine-flag", () => {
    for (const resolvedProvider of ALL_PROVIDERS) {
      for (const anthropicEngineEnabled of [true, false]) {
        const d = resolveLiveSdkFunnel({
          agentSlug: "operator",
          resolvedProvider,
          anthropicEngineEnabled,
        });
        expect(d.route).toBe("inline_anthropic");
        expect(d.providerForRun).toBe("anthropic");
        expect(d.useAnthropicEngine).toBe(false);
        expect(d.operatorPinned).toBe(true);
      }
    }
  });

  it("operator is pinned EVEN when a provider override would send it to OpenAI", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "operator",
      resolvedProvider: "openai",
      anthropicEngineEnabled: false,
    });
    expect(d.route).toBe("inline_anthropic");
    expect(d.providerForRun).toBe("anthropic");
  });

  it("operator is pinned EVEN when the anthropic-engine canary flag is ON", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "operator",
      resolvedProvider: "anthropic",
      anthropicEngineEnabled: true,
    });
    expect(d.route).toBe("inline_anthropic");
    expect(d.useAnthropicEngine).toBe(false);
  });
});

describe("resolveLiveSdkFunnel — non-operator agents route normally (no behavior change)", () => {
  it("anthropic + engine OFF → inline_anthropic", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "engineer",
      resolvedProvider: "anthropic",
      anthropicEngineEnabled: false,
    });
    expect(d).toEqual({
      route: "inline_anthropic",
      providerForRun: "anthropic",
      useAnthropicEngine: false,
      operatorPinned: false,
      operatorGateOnAltFunnel: false,
    });
  });

  it("anthropic + engine ON → anthropic_engine", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "engineer",
      resolvedProvider: "anthropic",
      anthropicEngineEnabled: true,
    });
    expect(d.route).toBe("anthropic_engine");
    expect(d.useAnthropicEngine).toBe(true);
    expect(d.operatorPinned).toBe(false);
  });

  it("openai provider → alt_provider (the OpenAI funnel)", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "engineer",
      resolvedProvider: "openai",
      anthropicEngineEnabled: false,
    });
    expect(d.route).toBe("alt_provider");
    expect(d.providerForRun).toBe("openai");
    expect(d.useAnthropicEngine).toBe(false);
  });

  it("anthropic-engine flag does NOT pull a non-anthropic provider onto the engine", () => {
    const d = resolveLiveSdkFunnel({
      agentSlug: "engineer",
      resolvedProvider: "openai",
      anthropicEngineEnabled: true,
    });
    expect(d.route).toBe("alt_provider");
    expect(d.useAnthropicEngine).toBe(false);
  });
});

describe("resolveLiveSdkFunnel — staff ?model= runs", () => {
  it("operator with a staff model → alt_provider + gate on alt funnel", () => {
    expect(resolveLiveSdkFunnel({ agentSlug: "operator", resolvedProvider: "anthropic", anthropicEngineEnabled: false, staffModel: true }))
      .toEqual({ route: "alt_provider", providerForRun: "openrouter", useAnthropicEngine: false, operatorPinned: false, operatorGateOnAltFunnel: true });
  });
  it("operator without a staff model → still pinned", () => {
    expect(resolveLiveSdkFunnel({ agentSlug: "operator", resolvedProvider: "openai", anthropicEngineEnabled: true }))
      .toMatchObject({ route: "inline_anthropic", operatorPinned: true, operatorGateOnAltFunnel: false });
  });
  it("non-operator with a staff model → openrouter, no operator gate", () => {
    expect(resolveLiveSdkFunnel({ agentSlug: "research", resolvedProvider: "anthropic", anthropicEngineEnabled: true, staffModel: true }))
      .toMatchObject({ route: "alt_provider", providerForRun: "openrouter", operatorGateOnAltFunnel: false });
  });
});
