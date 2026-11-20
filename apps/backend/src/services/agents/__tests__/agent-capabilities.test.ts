import { describe, it, expect } from "vitest";
import { AgentMetadataSchema } from "@/services/agents/types";
import { agentCapabilities } from "@/services/agents/registry";
import { DEFAULT_AGENT_MODEL } from "@/services/llm/models";

describe("agent capability flags (inert foundation)", () => {
  it("uses the product default only when an agent explicitly opts in", () => {
    expect(AgentMetadataSchema.parse({ model_policy: "default" }).model).toBe(
      DEFAULT_AGENT_MODEL,
    );
    expect(AgentMetadataSchema.safeParse({}).success).toBe(false);
  });

  it("defaults all flags to false when no capabilities block is declared", () => {
    const meta = AgentMetadataSchema.parse({ model: "claude-sonnet-4-6" });
    expect(meta.capabilities).toEqual({
      money_path: false,
      reads_operator_db: false,
      emits_artifact: false,
      structured_clarifications: false,
    });
  });

  it("reads a declared money_path flag off performance-marketer", () => {
    expect(agentCapabilities("performance-marketer").money_path).toBe(true);
  });

  it("returns all-false for an unknown slug", () => {
    expect(agentCapabilities("does-not-exist-agent")).toEqual({
      money_path: false,
      reads_operator_db: false,
      emits_artifact: false,
      structured_clarifications: false,
    });
  });
});
