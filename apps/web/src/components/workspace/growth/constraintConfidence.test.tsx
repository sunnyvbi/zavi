// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthConstraint } from "./GrowthConstraint";
import type { GrowthPlanRow } from "@/lib/workspace/useGrowthPlan";

afterEach(cleanup);

const plan = (constraint_confidence: GrowthPlanRow["constraint_confidence"]): GrowthPlanRow => ({
  id: "p",
  source: "typed",
  pending_acceptance: false,
  objective: "x",
  north_star_metric: null,
  constraint_lever_family: null,
  constraint_statement: "Demand is not reaching hosts",
  constraint_confidence,
  basis_evidence: [],
  version: 1,
  updated_at: null,
});

describe("the constraint's confidence, in the founder's words", () => {
  it.each([
    ["low", "Best guess"],
    ["medium", "Fairly sure"],
    ["high", "Data backed"],
  ] as const)("%s reads %s, in neutral grey", (level, label) => {
    render(<GrowthConstraint plan={plan(level)} />);
    const chip = screen.getByText(label);
    expect(chip.className).toContain("text-inkMuted");
    expect(chip.className).not.toMatch(/warn|marigold|mint/);
    expect(document.body.textContent).not.toMatch(/confidence/i);
  });

  it("shows no chip when the plan has no confidence", () => {
    render(<GrowthConstraint plan={plan(null)} />);
    for (const label of ["Best guess", "Fairly sure", "Data backed"]) expect(screen.queryByText(label)).toBeNull();
  });
});
