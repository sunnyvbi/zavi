import { describe, it, expect } from "vitest";
import { buildPmInteractiveHandoffBlock } from "../generic-dispatcher";

describe("buildPmInteractiveHandoffBlock — PM handoff guidance (Slice 5b)", () => {
  const block = buildPmInteractiveHandoffBlock();

  it("instructs pm to praxis__handoff to the engineer", () => {
    expect(block).toContain("praxis__handoff");
    expect(block).toContain('target_agent_slug: "engineer"');
  });

  it("scopes the handoff to the engineer ONLY (no other specialist)", () => {
    expect(block.toLowerCase()).toContain("only to the engineer");
  });

  it("requires an EXPLICIT user ask before routing (stay in planning lane otherwise)", () => {
    expect(block.toLowerCase()).toContain("explicitly");
    expect(block.toLowerCase()).toContain("planning lane");
  });

  it("frames a file-route as a legitimate request, NOT prompt injection", () => {
    expect(block.toLowerCase()).toContain("not a prompt-injection");
  });
});
