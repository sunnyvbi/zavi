
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({
  getStringSetting: async () => "enforce",
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: "approval", error: null }),
  }),
}));

vi.mock("@/services/agents/run-stop", () => ({
  isRunStopRequested: async () => false,
}));
vi.mock("@/services/agents/kill-switch", () => ({
  isAgentKilled: async () => false,
}));

vi.mock("../streamable-client", () => ({
  advertisedReadToolNames: () => undefined,
}));

const provisioned: { impl: (t: string, f: string) => Promise<unknown> } = {
  impl: async () => ({ ok: false, reason: "default" }),
};
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: (tenant_id: string, full: string) =>
    provisioned.impl(tenant_id, full),
}));

import { governActionOrBlock } from "../governance-enforce";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const PROVISIONED_REPO = { owner: "Praxis-build", repo: "handyhub-6ec4d609" };
const CUSTOMER_REPO = { owner: "acme-corp", repo: "their-private-app" };

const dispatchCtx = { tenant_id: TENANT, run_id: "run-1" };

beforeEach(() => {
  provisioned.impl = async () => ({ ok: false, reason: "default" });
});

describe("governed chokepoint — provisioned-repo github AUTO carve-out", () => {
  it("1. open_pr on a PROVISIONED repo + no approval channel → AUTO (proceeds), NOT blocked (the live-failing case)", async () => {
    provisioned.impl = async (_t, full) => ({ ok: true, github_full_name: full });
    const gate = await governActionOrBlock(dispatchCtx, "github", "open_pr", PROVISIONED_REPO);
    expect(gate.block).toBe(false);
  });

  it("2. open_pr on a NON-provisioned / customer repo + no approval channel → still BLOCKED approval (unchanged safety)", async () => {
    provisioned.impl = async () => ({ ok: false, reason: "no tenant_resources(repo) row" });
    const gate = await governActionOrBlock(dispatchCtx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.is_error).toBe(true);
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("3. assertProvisionedRepoTarget THROWS → fail-closed to approval (never accidental auto)", async () => {
    provisioned.impl = async () => {
      throw new Error("tenant_resources read blew up");
    };
    const gate = await governActionOrBlock(dispatchCtx, "github", "open_pr", PROVISIONED_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("3b. missing repo arg → fail-closed to approval (can't prove ownership)", async () => {
    provisioned.impl = async () => ({ ok: true, github_full_name: "x/y" });
    const gate = await governActionOrBlock(dispatchCtx, "github", "open_pr", { title: "no repo" });
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("4. push_to_main on a PROVISIONED repo → AUTO (regression guard — provisioned push path unchanged)", async () => {
    provisioned.impl = async (_t, full) => ({ ok: true, github_full_name: full });
    const gate = await governActionOrBlock(dispatchCtx, "github", "push_to_main", PROVISIONED_REPO);
    expect(gate.block).toBe(false);
  });

  it("4b. push_to_main on a NON-provisioned repo → still BLOCKED approval (never fast-forward a customer main)", async () => {
    provisioned.impl = async () => ({ ok: false, reason: "mode=connected (not provisioned)" });
    const gate = await governActionOrBlock(dispatchCtx, "github", "push_to_main", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("6. push_branch on a PROVISIONED repo → AUTO (the DEL-686 deterministic-block fix)", async () => {
    provisioned.impl = async (_t, full) => ({ ok: true, github_full_name: full });
    const gate = await governActionOrBlock(dispatchCtx, "github", "push_branch", PROVISIONED_REPO);
    expect(gate.block).toBe(false);
  });

  it("6b. push_branch on a NON-provisioned / customer repo → still BLOCKED approval (unchanged safety)", async () => {
    provisioned.impl = async () => ({ ok: false, reason: "mode=connected (not provisioned)" });
    const gate = await governActionOrBlock(dispatchCtx, "github", "push_branch", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("7. open_pr_from_branch + add_label on a PROVISIONED repo → AUTO (the rest of the refine-gate tool set)", async () => {
    provisioned.impl = async (_t, full) => ({ ok: true, github_full_name: full });
    const a = await governActionOrBlock(dispatchCtx, "github", "open_pr_from_branch", PROVISIONED_REPO);
    const b = await governActionOrBlock(dispatchCtx, "github", "add_label", PROVISIONED_REPO);
    expect(a.block).toBe(false);
    expect(b.block).toBe(false);
  });

  it("8. squash_merge on a PROVISIONED repo → STILL BLOCKED (a MERGE stays human-gated — the carve-out must never auto-merge)", async () => {
    provisioned.impl = async (_t, full) => ({ ok: true, github_full_name: full });
    const gate = await governActionOrBlock(dispatchCtx, "github", "squash_merge", PROVISIONED_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) expect(gate.result.is_error).toBe(true);
  });

  it("5. the carve-out does NOT loosen a non-github governed write — stripe still approval-gated on a provisioned-looking arg", async () => {
    provisioned.impl = async () => ({ ok: true, github_full_name: "Praxis-build/x" });
    const gate = await governActionOrBlock(dispatchCtx, "stripe", "create_payment", {
      owner: "Praxis-build",
      repo: "handyhub-6ec4d609",
      amount: 5000,
    });
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });
});
