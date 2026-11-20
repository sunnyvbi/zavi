
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({
  getStringSetting: async () => "enforce",
}));

const runRow: { trigger: string | null; readable: boolean } = {
  trigger: "chat",
  readable: true,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: "approval", error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            runRow.readable
              ? {
                  data: runRow.trigger === null ? null : { trigger: runRow.trigger },
                  error: null,
                }
              : { data: null, error: { message: "unreadable" } },
        }),
      }),
    }),
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
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: async () => ({ ok: false, reason: "customer-repo" }),
}));

import { governActionOrBlock } from "../governance-enforce";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const CUSTOMER_REPO = { owner: "acme-corp", repo: "their-private-app" };
const ctx = { tenant_id: TENANT, run_id: "run-1" };

beforeEach(() => {
  runRow.trigger = "chat";
  runRow.readable = true;
});

describe("governed chokepoint — interactive-authorized github open_pr carve-out", () => {
  it("1. open_pr on a CUSTOMER repo + interactive chat trigger + no approval channel → AUTO (proceeds), NOT the dead-end", async () => {
    runRow.trigger = "chat";
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(false);
  });

  it("2. open_pr + slack trigger → AUTO", async () => {
    runRow.trigger = "slack";
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(false);
  });

  it("3. open_pr + teams trigger → AUTO", async () => {
    runRow.trigger = "teams";
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(false);
  });

  it("4. open_pr + AUTONOMOUS trigger (cron) → still approval-gated → blocked (no channel → dead-end preserved for autonomous)", async () => {
    runRow.trigger = "cron";
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
    if (gate.block) {
      expect(gate.result.content).toContain("approval_channel_unavailable");
    }
  });

  it("5. open_pr + interactive trigger but UNREADABLE agent_runs row → fail-closed (NOT auto) → blocked", async () => {
    runRow.readable = false;
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("6. open_pr with NO run_id on ctx → fail-closed (can't attribute) → blocked", async () => {
    const noRunCtx = { tenant_id: TENANT };
    const gate = await governActionOrBlock(noRunCtx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("7. push_to_main + interactive chat trigger → NOT covered by this carve-out (customer main is a prod mutation) → blocked", async () => {
    runRow.trigger = "chat";
    const gate = await governActionOrBlock(ctx, "github", "push_to_main", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });

  it("8. missing agent_runs.trigger (null) on an interactive-looking run → fail-closed (NOT auto) → blocked", async () => {
    runRow.trigger = null;
    const gate = await governActionOrBlock(ctx, "github", "open_pr", CUSTOMER_REPO);
    expect(gate.block).toBe(true);
  });
});
