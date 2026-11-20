import { describe, it, expect } from "vitest";
import { buildPlaybookDirective } from "../directive";
import { PLAYBOOKS, getPlaybook } from "../index";

describe("buildPlaybookDirective", () => {
  it("names the playbook + its outcome + its data sources", () => {
    const pb = getPlaybook("recover-stalled-sellers")!;
    const d = buildPlaybookDirective(pb);
    expect(d).toContain('"Recover stalled sellers"');
    expect(d).toContain(pb.outcome);
    expect(d).toContain(pb.data_used[0]);
  });

  it("routes through the agent's OWN proposal tools — does NOT demand a custom card body", () => {
    const d = buildPlaybookDirective(getPlaybook("campaigns-over-cac")!);
    expect(d).toMatch(/propose_\*|proposal tools/i);
    expect(d).not.toContain("emitDecision");
    expect(d).not.toContain("surface_kind");
    expect(d).not.toContain("rendered_markdown");
  });

  it("carries the approval-gated + nothing-to-act + no-fabrication guards for every playbook", () => {
    for (const pb of PLAYBOOKS) {
      const d = buildPlaybookDirective(pb);
      expect(d).toMatch(/do NOT take[\s\S]*?the side effect yourself/i);
      expect(d).toMatch(/propose NOTHING|never invent an action/i);
      expect(d).toMatch(/never fabricate/i);
    }
  });
});
