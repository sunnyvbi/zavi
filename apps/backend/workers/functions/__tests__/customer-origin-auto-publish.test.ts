
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function refineBraked(
  pl: {
    stage?: unknown;
    refine_mode?: unknown;
    repair_mode?: unknown;
    customer_origin?: unknown;
  },
  directMergeEnabled: boolean,
): boolean {
  const stage = typeof pl.stage === "string" ? pl.stage : "";
  const isProductBuildNode = stage === "scaffold" || stage === "build";
  const isRefineNode = pl.refine_mode === true && pl.repair_mode !== true;
  if (!(isProductBuildNode && isRefineNode)) return false;
  return !directMergeEnabled;
}

describe("customer refines auto-publish by default (the setting is the kill-switch)", () => {
  const customerRefine = { stage: "build", refine_mode: true, customer_origin: true };

  it("AUTO-PUBLISHES a customer refine at the default (setting TRUE)", () => {
    expect(refineBraked(customerRefine, true)).toBe(false);
  });

  it("parks as a PR only when the tenant flips the kill-switch (setting FALSE)", () => {
    expect(refineBraked(customerRefine, false)).toBe(true);
  });

  it("a conductor initial build always direct-pushes (no refine_mode), regardless of the setting", () => {
    expect(refineBraked({ stage: "build" }, false)).toBe(false);
    expect(refineBraked({ stage: "scaffold" }, false)).toBe(false);
  });

  it("in-build repair (repair_mode) always direct-pushes — regression guard for the false-live-placeholder P0", () => {
    const repair = { stage: "build", refine_mode: true, repair_mode: true };
    expect(refineBraked(repair, false)).toBe(false);
    expect(refineBraked(repair, true)).toBe(false);
  });

  it("a non-product-build node never stamps push_to_main", () => {
    expect(refineBraked({ refine_mode: true, customer_origin: true }, true)).toBe(false);
  });
});

describe("source pins — auto-publish + the guards that replace the approval gate", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("post-run brakes a refine ONLY when the setting is off (no unconditional override)", () => {
    const postRun = src("../../../src/agents/engineer/post-run.ts");
    expect(postRun).toMatch(/refineBrakeActive\s*=\s*isRefineNode && !directMergeEnabled/);
    expect(postRun).not.toContain("isCustomerOriginEdit");
    expect(postRun).not.toMatch(/refineBrakeActive\s*=\s*true/);
  });

  it("refine-product still stamps the customer_origin marker (for observability)", () => {
    const refine = src("../../../src/services/agents/refine-product.ts");
    expect(refine).toContain("customer_origin: true");
  });

  it("dispatch-decision NO LONGER refuses a customer-origin push", () => {
    const dispatch = src("../dispatch-decision.ts");
    expect(dispatch).not.toContain("customer_origin_edit_requires_approval");
  });

  it("dispatch-decision KEEPS the fail-closed own-repo + protected-path guards", () => {
    const dispatch = src("../dispatch-decision.ts");
    expect(dispatch).toContain("assertProvisionedRepoTarget");
    expect(dispatch).toMatch(/runTarget !== proposalRepo/);
    expect(dispatch).toMatch(/protected_path/);
  });
});
