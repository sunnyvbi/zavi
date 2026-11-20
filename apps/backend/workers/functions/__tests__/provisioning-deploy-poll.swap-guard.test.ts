import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectSwappablePreviews } from "../provisioning-deploy-poll";

describe("Render going live never destroys a sandbox that is still in use", () => {
  it("only plain instant previews are swapped; live-edit and engineer previews are left to their own reaper", () => {
    const rows = [
      { id: "a", preview_run_id: null },
      { id: "b", preview_run_id: "live-edit:run-1" },
      { id: "c", preview_run_id: "run-42" },
      { id: "d" },
    ];
    expect(selectSwappablePreviews(rows).map((r) => r.id)).toEqual(["a", "d"]);
  });

  it("skips the swap entirely while the tenant has a build or change running, and when that check errors", () => {
    const src = readFileSync(join(__dirname, "../provisioning-deploy-poll.ts"), "utf-8");
    const swap = src.slice(src.indexOf("async swapPreviewOnReady(tenant_id) {"), src.indexOf("kickBuildConductors:"));
    expect(swap).toMatch(/\.from\("conductor_runs"\)[\s\S]*\.eq\("kind", "build_app"\)[\s\S]*\.in\("status", \["active", "provisioning"\]\)/);
    expect(swap).toMatch(/if \(activeErr \|\| \(\(active as unknown\[\] \| null\)\?\.length \?\? 0\) > 0\) return;/);
    expect(swap.indexOf("return;")).toBeLessThan(swap.indexOf("destroySandboxRow"));
    expect(swap).toMatch(/for \(const p of selectSwappablePreviews\(/);
  });
});
