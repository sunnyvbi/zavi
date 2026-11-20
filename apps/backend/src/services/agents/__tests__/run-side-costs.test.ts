import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  const rows: Array<{ tenant_id: string; run_id: string; cost_key: string; usd: number }> = [];
  const finished = new Set<string>();
  const state = { readError: null as null | { message: string }, rpcCalls: [] as unknown[] };
  const logs: Array<{ code: string }> = [];
  return { rows, finished, state, logs };
});

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    h.state.rpcCalls.push({ tid, name, args });
    if (name !== "add_run_side_cost") throw new Error("unexpected rpc " + name);
    const run_id = args.p_run_id as string;
    if (h.finished.has(run_id)) return { data: "run_finished", error: null };
    if (h.rows.some((r) => r.run_id === run_id && r.cost_key === args.p_cost_key)) {
      return { data: "already", error: null };
    }
    h.rows.push({ tenant_id: tid, run_id, cost_key: args.p_cost_key as string, usd: args.p_usd as number });
    return { data: "added", error: null };
  },
  tenantClient: (tid: string) => ({
    from: (table: string) => ({
      select: () => ({
        eq: async (_col: string, runId: string) => {
          expect(table).toBe("agent_run_side_costs");
          if (h.state.readError) return { data: null, error: h.state.readError };
          return {
            data: h.rows
              .filter((r) => r.tenant_id === tid && r.run_id === runId)
              .map((r) => ({ usd: String(r.usd) })),
            error: null,
          };
        },
      }),
    }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: { code: string }) => {
    h.logs.push(e);
  },
}));

import { addRunSideCost, sumRunSideCostsUsd } from "../run-side-costs";

const T = "11111111-1111-1111-1111-111111111111";
const R = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  h.rows.length = 0;
  h.finished.clear();
  h.state.readError = null;
  h.state.rpcCalls.length = 0;
  h.logs.length = 0;
});

describe("run side costs", () => {
  it("a zero side cost never calls the database", async () => {
    expect(await addRunSideCost({ tenantId: T, runId: R, usd: 0, source: "site_check", key: "tc_0" })).toBe("zero");
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it("re-recording the same tool call (a retry) does not double-count", async () => {
    await addRunSideCost({ tenantId: T, runId: R, usd: 0.2, source: "browser_task", key: "tc_2" });
    expect(await addRunSideCost({ tenantId: T, runId: R, usd: 0.2, source: "browser_task", key: "tc_2" })).toBe("already");
    await addRunSideCost({ tenantId: T, runId: R, usd: 0.05, source: "browser_task", key: "tc_3" });
    expect(await sumRunSideCostsUsd(T, R)).toBeCloseTo(0.25, 10);
  });

  it("only this tenant's rows for this run are summed", async () => {
    await addRunSideCost({ tenantId: T, runId: R, usd: 0.3, source: "site_check", key: "tc_4" });
    await addRunSideCost({ tenantId: "other-tenant", runId: R, usd: 9, source: "site_check", key: "tc_5" });
    await addRunSideCost({ tenantId: T, runId: "other-run", usd: 9, source: "site_check", key: "tc_6" });
    expect(await sumRunSideCostsUsd(T, R)).toBeCloseTo(0.3, 10);
  });

  it("a cost recorded after the run finished is reported, not silently billed", async () => {
    h.finished.add(R);
    expect(await addRunSideCost({ tenantId: T, runId: R, usd: 0.4, source: "site_check", key: "tc_7" })).toBe("run_finished");
    expect(h.logs.map((l) => l.code)).toContain("side_cost_run_finished");
  });

  it("the tenant is injected by the facade, never taken from args", async () => {
    await addRunSideCost({ tenantId: T, runId: R, usd: 0.01, source: "site_check", key: "tc_8" });
    expect(h.state.rpcCalls[0]).toMatchObject({
      tid: T,
      name: "add_run_side_cost",
      args: { p_run_id: R, p_cost_key: "tc_8", p_usd: 0.01, p_source: "site_check" },
    });
    expect((h.state.rpcCalls[0] as { args: object }).args).not.toHaveProperty("p_tenant_id");
  });

  it("rejects a negative or non-finite cost", async () => {
    await expect(addRunSideCost({ tenantId: T, runId: R, usd: -1, source: "x", key: "k" })).rejects.toThrow();
    await expect(addRunSideCost({ tenantId: T, runId: R, usd: Number.NaN, source: "x", key: "k" })).rejects.toThrow();
  });

});

describe("fold wiring", () => {
  const runner = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
  const migration = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations",
      "20261006120000_tool_side_costs_and_late_charge_refund.sql"),
    "utf8",
  );
  it("the terminal UPDATE folds the side-cost ledger into cost_usd, in the database", () => {
    expect(migration).toMatch(
      /create trigger trg_agent_runs_fold_side_costs\s+before update on agent_runs\s+for each row\s+when \(OLD\.finished_at is null and NEW\.finished_at is not null\)\s+execute function _trg_fold_run_side_costs\(\);/,
    );
    expect(migration).toMatch(
      /NEW\.cost_usd := coalesce\(NEW\.cost_usd, 0\)\s+\+ coalesce\(\(select sum\(usd\) from agent_run_side_costs where run_id = NEW\.id\), 0\);/,
    );
    expect(migration).toMatch(/revoke all on function _trg_fold_run_side_costs\(\) from public, anon, authenticated;/);
  });
  it("the runner does not add side costs itself (no double count)", () => {
    expect(runner).not.toMatch(/withRunSideCosts|sumRunSideCostsUsd|from\("agent_run_side_costs"\)|run-side-costs"/);
    expect(runner).toMatch(/update\.cost_usd = baseCostUsd \+ \(result\.routing\?\.classifier_cost_usd \?\? 0\);/);
  });
  it("the runner reports the billed (folded) cost after the terminal write", () => {
    expect(runner).toMatch(
      /\.eq\("status", "running"\)\s*\.select\("id, payload, cost_usd(?:, [a-z_]+)*"\);/,
    );
    expect(runner).toMatch(/if \(Number\.isFinite\(billedCostUsd\)\) update\.cost_usd = billedCostUsd;/);
  });
});
