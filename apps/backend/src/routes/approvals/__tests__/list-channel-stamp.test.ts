
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[] = [];
const rows = [
  { id: "d-1", agent_run_id: "run-1", decision_class: "meta_ads.budget", body: {}, status: "proposed", emitted_at: "2026-11-01T00:00:00Z" },
];
const manyRuns = Array.from({ length: 536 }, (_, i) => ({ id: `run-${i}`, channel_slug: "meta_ads", payload: {} }));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "not", "or", "gte", "lte", "order", "limit"]) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return chain;
        };
      }
      const data =
        table === "customer_visible_pending_decisions" ? rows : table === "agent_runs" ? manyRuns : [];
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
      return chain;
    },
  }),
}));

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  return {
    out,
    json: (b: Record<string, unknown>) => {
      out.body = b;
    },
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
}

const eqOn = (table: string, field: string) =>
  calls.filter((c) => c.table === table && c.method === "eq" && c.args[0] === field).map((c) => c.args[1]);

describe("GET /api/approvals?channel=meta_ads with 536 runs on the channel", () => {
  beforeEach(() => {
    calls = [];
    requireAuth.mockResolvedValue({ tenant_id: "t-1", access_token: "tok", user_id: "u" });
  });

  it("answers 200, filtered by the stamp and the tenant", async () => {
    const { approvalsList } = await import("../list");
    const r = res();
    await approvalsList({ query: { channel: "meta_ads" } } as never, r as never);
    expect(r.out.status).toBe(200);
    expect((r.out.body.decisions as Array<{ id: string }>).map((d) => d.id)).toContain("d-1");
    expect(eqOn("customer_visible_pending_decisions", "home")).toContain("channel");
    expect(eqOn("customer_visible_pending_decisions", "home_channel")).toEqual(["meta_ads"]);
    expect(eqOn("customer_visible_pending_decisions", "tenant_id")).toContain("t-1");
  });

  it("never looks up the channel's runs or sends a run id list", async () => {
    const { approvalsList } = await import("../list");
    await approvalsList({ query: { channel: "meta_ads" } } as never, res() as never);
    expect(eqOn("agent_runs", "channel_slug")).toEqual([]);
    const byRun = calls.filter((c) => c.method === "in" && c.args[0] === "agent_run_id");
    expect(byRun.flatMap((c) => c.args[1] as unknown[]).length).toBeLessThanOrEqual(1);
  });

  it("refuses a finished status with a channel, whose stamp may be older than its run", async () => {
    const { approvalsList } = await import("../list");
    const r = res();
    await approvalsList({ query: { channel: "meta_ads", status: "acted" } } as never, r as never);
    expect(r.out.status).toBe(400);
    expect(calls.filter((c) => c.table === "decisions" || c.table === "customer_visible_pending_decisions")).toEqual([]);
  });
});
