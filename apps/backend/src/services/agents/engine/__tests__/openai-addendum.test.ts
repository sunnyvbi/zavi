import { describe, it, expect } from "vitest";
import {
  applyOpenAiAddendum,
  OPENAI_BASE_ADDENDUM,
  OPENAI_AGENT_ADDENDA,
} from "../openai-addendum";
import { AGENT_OUTPUT_CLASS } from "@/services/agents/structured-output";

describe("openai-addendum overlay", () => {
  const SYS = "You are the X agent. Do X.";

  it("appends only the base addendum for an agent with no per-agent slot", () => {
    const out = applyOpenAiAddendum("no-such-agent", SYS);
    expect(out.startsWith(SYS)).toBe(true);
    expect(out).toContain(OPENAI_BASE_ADDENDUM);
    expect(out).not.toContain("RESEARCH-SPECIFIC");
    expect(out).not.toContain("ENGINEER-SPECIFIC");
  });

  it("every fleet agent (AGENT_OUTPUT_CLASS) has a non-empty per-agent addendum", () => {
    for (const slug of Object.keys(AGENT_OUTPUT_CLASS)) {
      const txt = OPENAI_AGENT_ADDENDA[slug];
      expect(txt, `missing per-agent addendum for "${slug}"`).toBeTruthy();
      expect(txt.trim().length, `empty addendum for "${slug}"`).toBeGreaterThan(40);
    }
  });

  it("appends base + per-agent for research", () => {
    const out = applyOpenAiAddendum("research", SYS);
    expect(out).toContain(OPENAI_BASE_ADDENDUM);
    expect(out).toContain(OPENAI_AGENT_ADDENDA.research);
    expect(out).toContain("RESEARCH-SPECIFIC");
    expect(out.indexOf(OPENAI_BASE_ADDENDUM)).toBeLessThan(
      out.indexOf("RESEARCH-SPECIFIC"),
    );
  });

  it("preserves the original system prompt verbatim as the prefix", () => {
    const out = applyOpenAiAddendum("research", SYS);
    expect(out.startsWith(SYS + "\n\n")).toBe(true);
  });

  it("base addendum encodes the four observed gpt-5.5 corrections", () => {
    expect(OPENAI_BASE_ADDENDUM).toMatch(/OVER-CLARIFY/);
    expect(OPENAI_BASE_ADDENDUM).toMatch(/OUTPUT SHAPE/);
    expect(OPENAI_BASE_ADDENDUM).toMatch(/THIN/);
    expect(OPENAI_BASE_ADDENDUM).toMatch(/SHARPEST/);
  });
});
