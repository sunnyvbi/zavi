
import { describe, it, expect } from "vitest";
import { isRoutableRoutineStepTool } from "../tool-name";

describe("isRoutableRoutineStepTool", () => {
  it("ACCEPTS a proper <server>__<tool> MCP name", () => {
    expect(isRoutableRoutineStepTool("github__get_repo")).toBe(true);
    expect(isRoutableRoutineStepTool("stripe__get_customer")).toBe(true);
    expect(isRoutableRoutineStepTool("composio__search")).toBe(true);
  });

  it("REJECTS a bare SDK sandbox name with no server split (unroutable)", () => {
    expect(isRoutableRoutineStepTool("run_bash")).toBe(false);
    expect(isRoutableRoutineStepTool("str_replace")).toBe(false);
    expect(isRoutableRoutineStepTool("str_replace_editor")).toBe(false);
  });

  it("REJECTS a tenant_skill__* name (no recursion)", () => {
    expect(isRoutableRoutineStepTool("tenant_skill__operator__abc12345")).toBe(false);
  });

  it("REJECTS an empty / separator-leading name", () => {
    expect(isRoutableRoutineStepTool("")).toBe(false);
    expect(isRoutableRoutineStepTool("__tool")).toBe(false);
  });
});
