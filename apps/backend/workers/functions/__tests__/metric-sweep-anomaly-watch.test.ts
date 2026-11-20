
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    halted: false as boolean,
    haltError: null as { message: string } | null,
    tenants: [] as Array<{ id: string }>,
    tenantFilters: [] as string[],
    connectors: [] as Array<{ tenant_id: string; slug: string }>,
    slugFilter: [] as unknown[],
  };
  const serviceClient = vi.fn(() => ({
    rpc: async () => ({ data: state.halted, error: state.haltError }),
    from: (table: string) => ({
      select: () => {
        if (table === "tenants") {
          const chain = {
            or: (f: string) => (state.tenantFilters.push(`or:${f}`), chain),
            is: (c: string, v: unknown) => (state.tenantFilters.push(`is:${c}:${v}`), chain),
            order: () => chain,
            limit: async () => ({ data: state.tenants, error: null }),
          };
          return chain;
        }
        return {
          in: () => ({
            in: async (_c: string, slugs: unknown[]) => {
              state.slugFilter = slugs;
              return { data: state.connectors, error: null };
            },
          }),
        };
      },
    }),
  }));
  return { state, serviceClient };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));

import { runAnomalyWatch } from "../metric-sweep";

const logger = { warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-09-28T05:41:00Z");
const result = { signals: 2, moves: 1, opened: 1, worsened: 0, recovered: 0, notices: 1, sent: 1, woke: 1, errors: 0 };

beforeEach(() => {
  m.state.halted = false;
  m.state.haltError = null;
  m.state.tenants = [{ id: "t-ga" }, { id: "t-none" }, { id: "t-off" }, { id: "t-boom" }];
  m.state.tenantFilters = [];
  m.state.connectors = [
    { tenant_id: "t-ga", slug: "google_analytics" },
    { tenant_id: "t-off", slug: "stripe" },
    { tenant_id: "t-boom", slug: "stripe" },
  ];
  vi.clearAllMocks();
});

describe("runAnomalyWatch", () => {
  it("fleet halt (or an unreadable halt flag) fails closed: no tenant is watched", async () => {
    const watch = vi.fn();
    m.state.haltError = { message: "db down" };
    expect(await runAnomalyWatch(logger, NOW, watch, async () => true)).toEqual({ skipped: true, reason: "fleet_kill_check_failed" });
    m.state.haltError = null;
    m.state.halted = true;
    expect(await runAnomalyWatch(logger, NOW, watch, async () => true)).toEqual({ skipped: true, reason: "fleet_halted" });
    expect(watch).not.toHaveBeenCalled();
  });

  it("watches live tenants with a watched connector, honours the kill switch, and isolates a throwing tenant", async () => {
    const watch = vi.fn(async (tenant_id: string, _slugs: ReadonlySet<string>) => {
      if (tenant_id === "t-boom") throw new Error("boom");
      return result;
    });
    const enabled = vi.fn(async (t: string) => t !== "t-off");
    const r = await runAnomalyWatch(logger, NOW, watch as never, enabled);
    expect(m.state.tenantFilters).toEqual(["or:kind.is.null,kind.neq.test", "is:deleted_at:null"]);
    expect(m.state.slugFilter).toEqual(expect.arrayContaining(["google_analytics", "stripe", "meta_ads", "google_ads", "google_search_console", "operator_db"]));
    expect(watch.mock.calls.map((c) => c[0])).toEqual(["t-ga", "t-boom"]);
    expect([...watch.mock.calls[0][1]]).toEqual(["google_analytics"]);
    expect(enabled).not.toHaveBeenCalledWith("t-none");
    expect(r).toMatchObject({ tenants_watched: 1, signals: 2, opened: 1, sent: 1, woke: 1, errors: 1 });
  });

  it("an unreadable kill switch skips that tenant (fails closed), the others still run", async () => {
    const watch = vi.fn(async (_t: string, _s: ReadonlySet<string>) => result);
    const enabled = vi.fn(async (t: string) => {
      if (t === "t-ga") throw new Error("settings read failed");
      return true;
    });
    const r = await runAnomalyWatch(logger, NOW, watch as never, enabled);
    expect(watch.mock.calls.map((c) => c[0])).toEqual(["t-off", "t-boom"]);
    expect(r).toMatchObject({ tenants_watched: 2, errors: 1 });
  });
});
