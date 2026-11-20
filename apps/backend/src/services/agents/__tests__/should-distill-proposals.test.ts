import { describe, it, expect } from "vitest";
import { queuedMemoryProposal, shouldDistillRun } from "../should-distill";
import type { ToolCallTrace } from "@/services/tools/types";

const call = (name: string, status: ToolCallTrace["status"] = "ok"): ToolCallTrace => ({
  name,
  input_preview: "",
  output_preview: "",
  ms: 1,
  status,
});

describe("queuedMemoryProposal", () => {
  it("is true for a successful memory__write call, prefixed or not", () => {
    expect(queuedMemoryProposal([call("memory__write")])).toBe(true);
    expect(queuedMemoryProposal([call("mcp__praxis__memory__write")])).toBe(true);
  });
  it("is false for a failed call, another tool, or no trace", () => {
    expect(queuedMemoryProposal([call("memory__write", "tool_error")])).toBe(false);
    expect(queuedMemoryProposal([call("memory__search")])).toBe(false);
    expect(queuedMemoryProposal(undefined)).toBe(false);
    expect(queuedMemoryProposal("junk" as unknown)).toBe(false);
  });
});

describe("shouldDistillRun with pending proposals", () => {
  it("a short-output run with pending proposals still distills", () => {
    expect(shouldDistillRun({ agent_slug: "operator", trigger: "cron", output_text_len: 3, has_pending_proposals: true })).toEqual({ ok: true });
  });
  it("without proposals the short-output floor still applies", () => {
    expect(shouldDistillRun({ agent_slug: "operator", trigger: "cron", output_text_len: 3 })).toEqual({ ok: false, reason: "output_too_short" });
  });
});
