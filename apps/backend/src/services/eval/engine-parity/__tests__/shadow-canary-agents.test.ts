
import { describe, it, expect } from "vitest";
import {
  SHADOW_CANARY_AGENTS,
  SHADOW_CANARY_CONVERSATIONAL_EXCLUDE,
  isShadowCanaryAgent,
  isShadowCanaryConversationalExcluded,
} from "../shadow-canary-agents";

describe("SHADOW_CANARY_AGENTS", () => {
  it("is exactly the stateless set: research, growth-lead, performance-marketer", () => {
    expect([...SHADOW_CANARY_AGENTS].sort()).toEqual(
      ["growth-lead", "performance-marketer", "research"].sort(),
    );
  });

  it("EXPLICITLY excludes the conversational agents", () => {
    expect([...SHADOW_CANARY_CONVERSATIONAL_EXCLUDE].sort()).toEqual(
      ["advisor", "chief-of-staff", "operator", "pm", "support-lead"].sort(),
    );
  });

  it("the two sets are disjoint (no agent both eligible AND excluded)", () => {
    for (const a of SHADOW_CANARY_AGENTS) {
      expect(SHADOW_CANARY_CONVERSATIONAL_EXCLUDE.has(a)).toBe(false);
    }
  });

  it("isShadowCanaryAgent is membership of the stateless set", () => {
    expect(isShadowCanaryAgent("research")).toBe(true);
    expect(isShadowCanaryAgent("growth-lead")).toBe(true);
    expect(isShadowCanaryAgent("pm")).toBe(false);
    expect(isShadowCanaryAgent("engineer")).toBe(false);
    expect(isShadowCanaryAgent(" research ")).toBe(true);
  });

  it("isShadowCanaryConversationalExcluded flags the conversational agents", () => {
    expect(isShadowCanaryConversationalExcluded("pm")).toBe(true);
    expect(isShadowCanaryConversationalExcluded("support-lead")).toBe(true);
    expect(isShadowCanaryConversationalExcluded("research")).toBe(false);
    expect(isShadowCanaryConversationalExcluded("brand-new-agent")).toBe(false);
  });
});
