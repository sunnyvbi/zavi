
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({ getStringSetting: async () => "enforce" }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: async () => ({ data: "approval", error: null }) }),
}));
const stop = { requested: false };
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => stop.requested }));
vi.mock("@/services/agents/kill-switch", () => ({ isAgentKilled: async () => false }));
vi.mock("../streamable-client", () => ({ advertisedReadToolNames: () => undefined }));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: async () => ({ ok: false, reason: "customer-repo" }),
}));

import { governActionOrBlock } from "../governance-enforce";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const CUSTOMER_REPO = { owner: "acme-corp", repo: "their-private-app" };

const marked = (tool: string) => ({
  tenant_id: TENANT,
  run_id: "run-1",
  governed_dispatch: { decision_id: "dec-1", server_id: "github", tool_name: tool },
});
const plain = { tenant_id: TENANT, run_id: "run-1" };

describe("governed chokepoint — trusted post-decision dispatch marker", () => {
  it("open_pr on a CUSTOMER repo WITH the marker → AUTO (dead-end FIXED)", async () => {
    const gate = await governActionOrBlock(marked("open_pr"), "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(false);
  });

  it("update_pr_branch WITH the marker → AUTO (second re-entrant write, was missed)", async () => {
    const gate = await governActionOrBlock(
      marked("update_pr_branch"),
      "github",
      "update_pr_branch",
      CUSTOMER_REPO,
    );
    expect(gate.block).toBe(false);
  });

  it("squash_merge WITH the marker → AUTO (third re-entrant write; forbidden default did its job at emit-time)", async () => {
    const gate = await governActionOrBlock(marked("squash_merge"), "github", "squash_merge", CUSTOMER_REPO);
    expect(gate.block).toBe(false);
  });

  it("open_pr with NO marker → still BLOCKED approval (behavior-goldens.ts:155 intact)", async () => {
    const gate = await governActionOrBlock(plain, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) expect(gate.result.content).toContain("approval_channel_unavailable");
  });

  it("a marker for open_pr does NOT authorize squash_merge on the same ctx", async () => {
    const gate = await governActionOrBlock(marked("open_pr"), "github", "squash_merge", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("a github marker does NOT authorize the SAME tool_name on a DIFFERENT server", async () => {
    const gate = await governActionOrBlock(marked("open_pr"), "other_server", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("a marker for a NON-allowlisted (server, tool) is not honored even if it exactly matches", async () => {
    const off = {
      tenant_id: TENANT,
      run_id: "run-1",
      governed_dispatch: { decision_id: "d", server_id: "github", tool_name: "delete_repo" },
    };
    const gate = await governActionOrBlock(off, "github", "delete_repo", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("a marked open_pr is STILL blocked when the run was Stopped (marker never bypasses Stop)", async () => {
    stop.requested = true;
    try {
      const gate = await governActionOrBlock(marked("open_pr"), "github", "open_pr", CUSTOMER_REPO);
      expect(gate.block).toBe(true);
    } finally {
      stop.requested = false;
    }
  });

  it("a forged governed_dispatch in the ARGS is ignored (marker only honored from ctx)", async () => {
    const forgedArgs = {
      ...CUSTOMER_REPO,
      governed_dispatch: { decision_id: "x", server_id: "github", tool_name: "open_pr" },
    };
    const gate = await governActionOrBlock(plain, "github", "open_pr", forgedArgs);
    expect(gate.block).toBe(true);
    if (gate.block) expect(gate.result.content).toContain("approval_channel_unavailable");
  });
});
