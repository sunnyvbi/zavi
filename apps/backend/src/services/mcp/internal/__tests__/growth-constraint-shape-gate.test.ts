import { describe, it, expect, vi, beforeEach } from "vitest";

const shape = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/services/growth/business-shape", () => ({ resolveBusinessShape: vi.fn(async () => shape.value) }));

import { callGrowthTool } from "../growth";
import { growthConstraintDiagnosisTool } from "@/services/tools/growth/growth_constraint_diagnosis";

describe("growth__constraint_diagnosis is for marketplaces", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";
  const realExecute = growthConstraintDiagnosisTool.execute;
  beforeEach(() => {
    growthConstraintDiagnosisTool.execute = vi.fn(async () => ({ status: "requires_mapping_confirmation" })) as typeof realExecute;
  });

  it("runs for a marketplace", async () => {
    shape.value = "marketplace";
    const res = await callGrowthTool(TENANT, "constraint_diagnosis", {});
    expect(res.ok).toBe(true);
    expect(growthConstraintDiagnosisTool.execute).toHaveBeenCalled();
    growthConstraintDiagnosisTool.execute = realExecute;
  });

  it.each(["saas", "services", "other", null])("refuses shape %s without running the read", async (s) => {
    shape.value = s;
    const res = await callGrowthTool(TENANT, "constraint_diagnosis", {});
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content).error).toBe("marketplace_only");
    expect(growthConstraintDiagnosisTool.execute).not.toHaveBeenCalled();
    growthConstraintDiagnosisTool.execute = realExecute;
  });
});
