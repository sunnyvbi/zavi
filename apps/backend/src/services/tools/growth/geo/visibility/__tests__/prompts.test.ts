import { describe, it, expect } from "vitest";
import { validatePromptText, PROMPT_MAX_CHARS } from "../prompts";
import { brandAliasesOf } from "../detect";

const aliases = brandAliasesOf("Zavi", ["zaviagent.com"]);

describe("validatePromptText", () => {
  it("accepts an unbranded buyer question, normalising whitespace", () => {
    expect(validatePromptText("  best AI marketing agent\n for a  small team ", aliases)).toEqual({
      ok: true,
      text: "best AI marketing agent for a small team",
    });
  });

  it("refuses a prompt that names the brand", () => {
    expect(validatePromptText("is Zavi worth it for startups", aliases)).toMatchObject({ ok: false, code: "prompt_is_branded" });
  });

  it("refuses a prompt that names an owned domain", () => {
    expect(validatePromptText("reviews of zaviagent.com", aliases)).toMatchObject({ ok: false, code: "prompt_is_branded" });
  });

  it("allows a rival's name — an 'alternatives to X' question is unbranded for us", () => {
    expect(validatePromptText("alternatives to HubSpot for a small team", aliases).ok).toBe(true);
  });

  it("does not treat a word merely containing the brand as branded", () => {
    expect(validatePromptText("how does Zavier pricing compare", aliases).ok).toBe(true);
  });

  it("enforces the length bounds DataForSEO accepts", () => {
    expect(validatePromptText("short", aliases)).toMatchObject({ ok: false, code: "prompt_too_short" });
    expect(validatePromptText("x".repeat(PROMPT_MAX_CHARS + 1), aliases)).toMatchObject({ ok: false, code: "prompt_too_long" });
  });
});

describe("validatePromptText — a pasted brand URL is still branded", () => {
  it("refuses a prompt carrying the brand's own address", () => {
    expect(validatePromptText("what do people say about https://zaviagent.com/pricing", aliases)).toMatchObject({
      ok: false,
      code: "prompt_is_branded",
    });
  });
});
