import { describe, it, expect } from "vitest";
import {
  buildStablePromptPrefix,
  GROUNDING_GUARDRAIL_INSTRUCTION,
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

describe("grounding guardrail — fleet-wide soft-wall prevention", () => {
  it("the stable prefix contains the grounding guardrail instruction", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    expect(prefix).toContain(GROUNDING_GUARDRAIL_INSTRUCTION);
    expect(prefix).toContain("never guess after an access failure");
  });

  it("the guardrail forbids substituting unverified specifics", () => {
    expect(GROUNDING_GUARDRAIL_INSTRUCTION).toContain("Do NOT substitute");
    expect(GROUNDING_GUARDRAIL_INSTRUCTION).toMatch(
      /unverified number, dollar amount, percentage/i,
    );
    expect(GROUNDING_GUARDRAIL_INSTRUCTION).toContain("not verified THIS run");
  });

  it("appears exactly once in the prefix (no double-append)", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    const occurrences = prefix.split(
      "## Grounding — never guess after an access failure",
    ).length - 1;
    expect(occurrences).toBe(1);
  });
});
