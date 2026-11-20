
import { describe, it, expect } from "vitest";
import {
  refusesConversationalAgent,
  isDeepAgentConversationalAllowed,
} from "../conversational-guard";
import { STATELESS_PROVIDERS } from "@/services/llm/models";

const OFF = {} as NodeJS.ProcessEnv;
const ON = { PRAXIS_DEEPAGENT_ALLOW_CONVERSATIONAL: "1" } as NodeJS.ProcessEnv;

describe("refusesConversationalAgent — default (flag off)", () => {
  it("refuses EVERY stateless provider for a conversational agent", () => {
    for (const p of STATELESS_PROVIDERS) {
      expect(refusesConversationalAgent(p, "pm", OFF)).toBe(true);
      expect(refusesConversationalAgent(p, "advisor", OFF)).toBe(true);
    }
  });

  it("allows a stateless provider for a NON-conversational agent", () => {
    for (const p of STATELESS_PROVIDERS) {
      expect(refusesConversationalAgent(p, "research", OFF)).toBe(false);
      expect(refusesConversationalAgent(p, "growth-lead", OFF)).toBe(false);
    }
  });

  it("never blocks a stateful provider", () => {
    expect(refusesConversationalAgent("anthropic", "pm", OFF)).toBe(false);
    expect(refusesConversationalAgent("openai", "pm", OFF)).toBe(false);
  });
});

describe("refusesConversationalAgent — PRAXIS_DEEPAGENT_ALLOW_CONVERSATIONAL=1", () => {
  it("lifts the refusal for langchain on chat agents", () => {
    expect(refusesConversationalAgent("langchain", "pm", ON)).toBe(false);
    expect(refusesConversationalAgent("langchain", "chief-of-staff", ON)).toBe(false);
    expect(refusesConversationalAgent("langchain", "support-lead", ON)).toBe(false);
    expect(refusesConversationalAgent("langchain", "advisor", ON)).toBe(false);
  });

  it("NEVER lifts it for operator — that agent is pinned to the inline funnel, so an override would be written and then ignored", () => {
    expect(refusesConversationalAgent("langchain", "operator", ON)).toBe(true);
  });

  it("does NOT leak to the other stateless providers", () => {
    for (const p of STATELESS_PROVIDERS.filter((x) => x !== "langchain")) {
      expect(refusesConversationalAgent(p, "pm", ON)).toBe(true);
    }
  });

  it("reads the flag strictly — only \"1\" arms it", () => {
    for (const v of ["0", "true", "yes", ""]) {
      expect(
        isDeepAgentConversationalAllowed({
          PRAXIS_DEEPAGENT_ALLOW_CONVERSATIONAL: v,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
    expect(isDeepAgentConversationalAllowed(ON)).toBe(true);
  });
});
