import { describe, it, expect } from "vitest";
import { enqueueAgentRun, SafetyGateError } from "@/services/agents/runner";

describe("enqueueAgentRun: AI-media agents from an AI assistant", () => {
  it("refuses generated_video on the mcp trigger", async () => {
    const run = enqueueAgentRun({ agent_slug: "generated_video", tenant_id: "T1", trigger: "mcp" });
    await expect(run).rejects.toBeInstanceOf(SafetyGateError);
    await expect(run).rejects.toThrow(/not available on runs started from an AI assistant/i);
  });
});
