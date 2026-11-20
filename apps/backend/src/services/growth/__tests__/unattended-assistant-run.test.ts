
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  trigger: "mcp" as string | null,
  runReadError: null as { message: string } | null,
  reads: [] as string[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      let cols = "";
      const q = {
        select: (c: string) => {
          cols = c;
          db.reads.push(`${table}:${c}`);
          return q;
        },
        eq: () => q,
        in: () => q,
        is: () => q,
        gte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () =>
          table === "agent_runs" && cols === "trigger"
            ? { data: db.runReadError ? null : { trigger: db.trigger }, error: db.runReadError }
            : { data: null, error: { message: "not stubbed in this test" } },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "not stubbed in this test" } }),
      };
      return q;
    },
  }),
}));

import { authorizeUnattended } from "../unattended-policy";

const T = "44444444-4444-4444-8444-444444444444";
const budgetUp = {
  kind: "ad" as const,
  exec_class: "meta_ads.update_ad_set_budget",
  payload: { adset_id: "a1", daily_budget_usd: 40, expected_current_daily_budget_usd: 20 },
  source: { table: "decisions" as const, id: "d-1", run_id: "run-1" },
};

beforeEach(() => {
  db.trigger = "mcp";
  db.runReadError = null;
  db.reads.length = 0;
});

describe("authorizeUnattended on a run started from an AI assistant", () => {
  it("must-catch: an ad change from an assistant run is the person's to approve, and nothing else is read", async () => {
    const v = await authorizeUnattended(T, budgetUp, { where: "door" });
    expect(v).toEqual({ verdict: "deny", reasons: ["assistant_run_change"] });
    expect(db.reads).toEqual(["agent_runs:trigger"]);
  });

  it("must-catch: a channel action from an assistant run is held the same way", async () => {
    const v = await authorizeUnattended(T, { ...budgetUp, exec_class: "reddit_ads.update_budget", source: { table: "channel_actions", id: "ca-1", run_id: "run-1" } });
    expect(v.reasons).toEqual(["assistant_run_change"]);
  });

  it("must-not-touch: a run started anywhere else goes through the gate as before", async () => {
    for (const trigger of ["chat", "slack", "cron", "handoff", "manual", null]) {
      db.trigger = trigger;
      db.reads.length = 0;
      const v = await authorizeUnattended(T, budgetUp, { where: "door" });
      expect(v.reasons).not.toContain("assistant_run_change");
      expect(db.reads.some((r) => r !== "agent_runs:trigger")).toBe(true);
    }
  });

  it("must-not-touch: a change with no source run (cgo's own orders) is not looked up", async () => {
    const v = await authorizeUnattended(T, { ...budgetUp, source: { ...budgetUp.source, run_id: null } });
    expect(v.reasons).not.toContain("assistant_run_change");
    expect(db.reads).not.toContain("agent_runs:trigger");
  });

  it("must-not-touch: gate actions that are not ad changes never read the run's trigger", async () => {
    await authorizeUnattended(T, { kind: "goal_change", trigger: "review" });
    expect(db.reads).not.toContain("agent_runs:trigger");
  });

  it("fails closed when the run cannot be read", async () => {
    db.runReadError = { message: "timeout" };
    expect(await authorizeUnattended(T, budgetUp)).toEqual({ verdict: "ask_founder", reasons: ["gate_error"] });
  });
});
