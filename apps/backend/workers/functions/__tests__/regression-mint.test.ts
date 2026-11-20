import { describe, it, expect } from "vitest";
import { deriveStepsAndFailingTool } from "../regression-mint";

describe("deriveStepsAndFailingTool", () => {
  it("builds the ordered step seq from tool_name/code meta", () => {
    const { steps } = deriveStepsAndFailingTool([
      { stage: "tool_use_started", meta: { tool_name: "github__list_files" } },
      { stage: "tool_use_completed", meta: { tool_name: "github__list_files", code: "ok" } },
      { stage: "tool_use_errored", meta: { tool_name: "github__create_pr", code: "parse_failed" } },
    ]);
    expect(steps).toEqual([
      { tool_name: "github__list_files", code: null },
      { tool_name: "github__list_files", code: "ok" },
      { tool_name: "github__create_pr", code: "parse_failed" },
    ]);
  });

  it("picks the last tool that carried a code as the failing tool", () => {
    const { failing_tool_name } = deriveStepsAndFailingTool([
      { stage: "tool_use_completed", meta: { tool_name: "a", code: "ok" } },
      { stage: "tool_use_errored", meta: { tool_name: "b", code: "boom" } },
    ]);
    expect(failing_tool_name).toBe("b");
  });

  it("falls back to the last tool seen when no code-bearing event exists", () => {
    const { failing_tool_name } = deriveStepsAndFailingTool([
      { stage: "tool_use_started", meta: { tool_name: "first" } },
      { stage: "tool_use_started", meta: { tool_name: "last" } },
    ]);
    expect(failing_tool_name).toBe("last");
  });

  it("returns null failing tool + empty steps for an event-less run", () => {
    expect(deriveStepsAndFailingTool([])).toEqual({
      steps: [],
      failing_tool_name: null,
    });
  });

  it("ignores non-string / missing meta fields safely", () => {
    const { steps, failing_tool_name } = deriveStepsAndFailingTool([
      { stage: "x", meta: null },
      { stage: "y", meta: { tool_name: 123 as unknown as string } },
      { stage: "z", meta: { code: "err", tool_name: "real_tool" } },
    ]);
    expect(steps).toEqual([{ tool_name: "real_tool", code: "err" }]);
    expect(failing_tool_name).toBe("real_tool");
  });
});
