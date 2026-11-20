import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  claimsEnforced: true,
  claims: new Set<string>(),
  history: new Map<string, string>(),
  a2a: [] as string[],
}));

vi.mock("@/services/agents/a2a-dispatch", () => ({
  a2aDispatch: vi.fn(async (input: { dedup_key: string }) => {
    await new Promise((r) => setTimeout(r, 5));
    const id = `child-${h.a2a.length + 1}`;
    h.a2a.push(input.dedup_key);
    h.history.set(input.dedup_key, id);
    return { ok: true, child_run_id: id };
  }),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "conductor_dispatch_claims") {
        return {
          insert: async (row: { conductor_run_id: string; dedup_key: string }) => {
            await Promise.resolve();
            const key = `${row.conductor_run_id}:${row.dedup_key}`;
            if (h.claimsEnforced && h.claims.has(key)) return { error: { code: "23505", message: "duplicate" } };
            h.claims.add(key);
            return { error: null };
          },
          delete: () => {
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.lt = () => chain;
            chain.then = (res: (v: { error: null }) => unknown) => res({ error: null });
            return chain;
          },
        };
      }
      const q: Record<string, unknown> = {};
      let dedup = "";
      q.select = () => q;
      q.eq = (c: string, v: string) => {
        if (c === "dedup_key") dedup = v;
        return q;
      };
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => {
        const id = h.history.get(dedup);
        return { data: id ? { target_run_id: id } : null, error: null };
      };
      return q;
    },
  }),
}));
vi.mock("@/services/hosting/static-publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/hosting/static-publish")>()),
  readStaticState: vi.fn(async () => null),
}));

import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";
import { realConductorTickDeps } from "../conductor-driver";

const graph = (): ConductorNode[] => [
  { id: "build", status: "pending", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 1, child_run_id: null },
];

function depsFor(saved: ConductorNode[][]): ConductorTickDeps {
  const row: ConductorRow = {
    id: "cr-1",
    tenant_id: "t1",
    objective: "o",
    goal_graph: graph(),
    status: "active",
    max_usd: 100,
    spend_usd: 0,
  };
  return {
    load: async () => ({ ...row, goal_graph: graph() }),
    childStatus: async () => "running",
    consumeBudget: async () => "charged",
    dispatch: realConductorTickDeps.dispatch,
    saveGraph: async (_id, g) => {
      saved.push(g);
    },
    setStatus: async () => {},
    isActive: async () => true,
    now: () => Date.parse("2026-10-02T10:00:00Z"),
  };
}

beforeEach(() => {
  h.claimsEnforced = true;
  h.claims.clear();
  h.history.clear();
  h.a2a.length = 0;
});

describe("two concurrent ticks of one run", () => {
  it("start the node's agent run once, and both ticks end up pointing at that one run", async () => {
    const saved: ConductorNode[][] = [];
    const results = await Promise.all([conductorTick("cr-1", depsFor(saved)), conductorTick("cr-1", depsFor(saved))]);
    expect(h.a2a).toHaveLength(1);
    const dispatched = results.filter((r) => r.action === "dispatched");
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    for (const g of saved) expect(g[0].child_run_id).toBe("child-1");
    for (const r of results) expect(["dispatched", "waiting"]).toContain(r.action);
  });

  it("a tick that arrives after the first finished adopts the same run instead of starting another", async () => {
    const saved: ConductorNode[][] = [];
    await conductorTick("cr-1", depsFor(saved));
    const second = await conductorTick("cr-1", depsFor(saved));
    expect(h.a2a).toHaveLength(1);
    expect(second).toMatchObject({ action: "dispatched", child_run_id: "child-1" });
  });

  it("control: with the claim not enforced the same race starts the node twice, so the fixture does let the bug through", async () => {
    h.claimsEnforced = false;
    const saved: ConductorNode[][] = [];
    await Promise.all([conductorTick("cr-1", depsFor(saved)), conductorTick("cr-1", depsFor(saved))]);
    expect(h.a2a).toHaveLength(2);
  });
});
