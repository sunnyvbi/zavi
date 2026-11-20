import { describe, it, expect } from "vitest";
import { BROWSER_OPERATOR_ALLOWED_TRIGGERS } from "@/services/agents/runner";
import { AGENT_TRIGGERS } from "@/services/agents/types";

describe("browser-operator — retired, no enqueue triggers", () => {
  it("the allowed-trigger set is empty", () => {
    expect([...BROWSER_OPERATOR_ALLOWED_TRIGGERS]).toEqual([]);
  });

  it.each([...AGENT_TRIGGERS])("keeps %s out", (trigger) => {
    expect(BROWSER_OPERATOR_ALLOWED_TRIGGERS.has(trigger)).toBe(false);
  });
});
