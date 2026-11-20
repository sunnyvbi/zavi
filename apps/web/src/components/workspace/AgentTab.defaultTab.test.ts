
import { describe, it, expect } from "vitest";
import { defaultTab, parseInnerTab } from "./AgentTab";

describe("defaultTab", () => {
  it("lands EVERY agent on Dashboard, engineer included", () => {
    for (const slug of ["engineer", "pm", "operator", "growth-lead", "zavi"]) {
      expect(defaultTab(slug)).toBe("dashboard");
    }
  });
});

describe("parseInnerTab", () => {
  it("never lands the engineer on preview without an explicit ask", () => {
    expect(parseInnerTab(null, "engineer")).toBe("dashboard");
  });

  it("honors an explicit ?tab=preview on the engineer", () => {
    expect(parseInnerTab("preview", "engineer")).toBe("preview");
  });

  it("keeps the engineer's other tabs deep-linkable", () => {
    expect(parseInnerTab("schedule", "engineer")).toBe("schedule");
    expect(parseInnerTab("feedback", "engineer")).toBe("feedback");
  });

  it("falls back to Dashboard for retired/garbage tab params", () => {
    for (const raw of ["chat", "runs", "policy", "', 'nope"]) {
      expect(parseInnerTab(raw, "engineer")).toBe("dashboard");
      expect(parseInnerTab(raw, "pm")).toBe("dashboard");
    }
  });

  it("never resolves a non-engineer to preview, even if the URL asks", () => {
    expect(parseInnerTab("preview", "pm")).toBe("dashboard");
  });
});
