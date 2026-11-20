import { describe, it, expect } from "vitest";
import {
  buildStablePromptPrefix,
  CHALLENGE_HANDLING_INSTRUCTION,
} from "../generic-dispatcher";

const BODY = "# pm\n\nYou are an agent. Tenant: {{tenant.name}}.\n";
const TENANT = { name: "Upcar" };
const MEMORY = {
  company: "test co",
  ops: "test ops",
  policies: "",
  disputes: "",
  support: "",
};

describe("challenge-handling guardrail — fleet-wide flip-flop prevention", () => {
  it("the stable prefix contains the challenge-handling instruction", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    expect(prefix).toContain(CHALLENGE_HANDLING_INSTRUCTION);
    expect(prefix).toContain("a user challenge is not evidence");
  });

  it("the guard blocks pressure-flips but allows evidence-based correction", () => {
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/treat it as a request to RE-VERIFY/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/Do NOT flip to the opposite/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/your own earlier reply is NOT itself evidence/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/only the source is/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/shows you were genuinely wrong, correct it/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/terminology\/interpretation clarification/i);
    expect(CHALLENGE_HANDLING_INSTRUCTION).toMatch(/Good catch/i);
  });

  it("appears exactly once in the prefix (no double-append)", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    const occurrences =
      prefix.split("## Challenge handling — a user challenge is not evidence")
        .length - 1;
    expect(occurrences).toBe(1);
  });
});
