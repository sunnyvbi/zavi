import { describe, it, expect } from "vitest";
import { runGroundingChecks, hasHardGroundingFlag } from "@/services/agents/eval/grounding-checks";

const STATE_CLAIM_OUTPUT = "The migration is already staged and waiting for your click.";

describe("grounding-checks C4 synthesizer downgrade (Bundle D D-4a-ii)", () => {
  it("HARD-flags a tc=0 state claim for a tool-using agent (engineer)", () => {
    const r = runGroundingChecks({ evidence: [], agent_output: STATE_CLAIM_OUTPUT, agentSlug: "engineer" });
    const c4 = r.flags.find((f) => f.pattern === "tc0_state_claim");
    expect(c4?.severity).toBe("hard");
    expect(hasHardGroundingFlag(r)).toBe(true);
  });

  it("downgrades the SAME claim to SOFT for a synthesizer agent (chief-of-staff)", () => {
    const r = runGroundingChecks({ evidence: [], agent_output: STATE_CLAIM_OUTPUT, agentSlug: "chief-of-staff" });
    const c4 = r.flags.find((f) => f.pattern === "tc0_state_claim");
    expect(c4?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("defaults to HARD when no agentSlug is supplied (backward-compatible)", () => {
    const r = runGroundingChecks({ evidence: [], agent_output: STATE_CLAIM_OUTPUT });
    expect(r.flags.find((f) => f.pattern === "tc0_state_claim")?.severity).toBe("hard");
  });
});
