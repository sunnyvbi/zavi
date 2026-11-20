import { describe, it, expect, vi, beforeEach } from "vitest";

const serviceClient = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClient(),
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: vi.fn(),
  FleetHaltedError: class extends Error {},
}));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));

import { relaneStaleLocalItems, LOCAL_LANE_RELANE_AFTER_MS } from "../work-queue";

type Call = { method: string; args: unknown[] };

function queryMock(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "update", "eq", "lt", "is"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.select = (...args: unknown[]) => {
    calls.push({ method: "select", args });
    return Promise.resolve(result);
  };
  return { chain, calls };
}

beforeEach(() => {
  serviceClient.mockReset();
});

describe("relaneStaleLocalItems", () => {
  it("flips stale pending local rows to e2b, filtered to lane=local + status=pending + stale", async () => {
    const { chain, calls } = queryMock({ data: [{ id: "a" }, { id: "b" }], error: null });
    serviceClient.mockReturnValue(chain);

    const n = await relaneStaleLocalItems();
    expect(n).toBe(2);

    expect(calls.find((c) => c.method === "from")?.args[0]).toBe("agent_work_items");
    const upd = calls.find((c) => c.method === "update")?.args[0] as { lane?: string };
    expect(upd.lane).toBe("e2b");
    const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["lane", "local"]);
    expect(eqs).toContainEqual(["status", "pending"]);
    const isCall = calls.find((c) => c.method === "is");
    expect(isCall?.args).toEqual(["agent_run_id", null]);
    const lt = calls.find((c) => c.method === "lt");
    expect(lt?.args[0]).toBe("next_run_at");
    const cutoffMs = Date.parse(lt?.args[1] as string);
    const expected = Date.now() - LOCAL_LANE_RELANE_AFTER_MS;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(5000);
  });

  it("honors a custom threshold", async () => {
    const { chain, calls } = queryMock({ data: [], error: null });
    serviceClient.mockReturnValue(chain);
    await relaneStaleLocalItems(60 * 1000);
    const lt = calls.find((c) => c.method === "lt");
    const cutoffMs = Date.parse(lt?.args[1] as string);
    expect(Math.abs(cutoffMs - (Date.now() - 60 * 1000))).toBeLessThan(5000);
  });

  it("returns 0 (fail-safe) on a DB error — never throws into the drainer tick", async () => {
    const { chain } = queryMock({ data: null, error: { message: "boom" } });
    serviceClient.mockReturnValue(chain);
    await expect(relaneStaleLocalItems()).resolves.toBe(0);
  });

  it("returns 0 when nothing is stale", async () => {
    const { chain } = queryMock({ data: [], error: null });
    serviceClient.mockReturnValue(chain);
    await expect(relaneStaleLocalItems()).resolves.toBe(0);
  });
});
