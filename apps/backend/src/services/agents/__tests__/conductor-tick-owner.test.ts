import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MINE = "dev:laptop";
const OTHER = "canonical";

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  rows: [] as Array<{ id: string; tenant_id: string; kind: string; goal_graph?: unknown }>,
  selects: [] as string[],
  ownerOnly: true,
  driverDeps: { repairConfig: { enabled: false } } as Record<string, unknown>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      const builder: Record<string, unknown> = {
        select: (cols: string) => (h.selects.push(cols), builder),
        eq: (c: string, v: unknown) => (eqs.push([c, v]), builder),
        order: () => builder,
        not: () => builder,
        contains: () => (eqs.push(["__parked", true]), builder),
        limit: () => {
          if (eqs.some(([c]) => c === "__parked")) return Promise.resolve({ data: [], error: null });
          const byId = eqs.find(([c]) => c === "id");
          return Promise.resolve({
            data: byId ? h.rows.filter((r) => r.id === byId[1]) : h.rows,
            error: null,
          });
        },
        maybeSingle: () => Promise.resolve({ data: { goal_graph: [] }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/agents/conductor", () => ({ conductorTick: h.tick }));
vi.mock("@/services/agents/conductor-driver", () => ({
  realConductorTickDeps: h.driverDeps,
  isConductorEnabled: async () => true,
  resolveConductorRepairEnabled: async () => false,
}));
vi.mock("@/services/agents/continue-build", () => ({ expireStalePausedBuilds: vi.fn(async () => 0) }));
vi.mock("@/services/agents/conductor-ledger", () => ({
  appendConductorAction: vi.fn().mockResolvedValue(undefined),
  isLoggableTick: () => false,
}));
vi.mock("@/services/agents/conductor-observability", () => ({ logBuildTick: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => false }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async (key: string) => (key === "conductor_owner_only" ? h.ownerOnly : true),
}));

import { conductorTickFn, conductorTickRequestedFn } from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";

type Handler = (ctx: {
  event?: unknown;
  logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
}) => Promise<Record<string, unknown>>;

const cronFn = (conductorTickFn as unknown as { fn: Handler }).fn;
const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const send = vi.spyOn(inngest, "send");

const row = (id: string, owner: string | null) => ({ id, tenant_id: "tnt", kind: "build_app", goal_graph: owner ? [{ id: "n", payload: { owner_worker: owner } }] : [] });
const requested = (id: string) => ({ name: "conductor/tick.requested", data: { conductor_run_id: id } });

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
  vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "1");
  vi.stubEnv("HOSTNAME", "laptop");
  h.tick.mockReset();
  h.tick.mockResolvedValue({ action: "dispatched", node_id: "n", child_run_id: "c" });
  h.rows = [];
  h.selects.length = 0;
  h.ownerOnly = true;
  send.mockReset();
  send.mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("conductor-tick ownership", () => {
  it("this worker is the dev laptop in these tests", async () => {
    const { workerId } = await import("../boot-role");
    expect(workerId()).toBe(MINE);
  });

  it("the cron sweep fans out its own and unstamped runs and skips another worker's run", async () => {
    h.rows = [row("00000000-0000-4000-8000-000000000001", MINE), row("00000000-0000-4000-8000-000000000002", OTHER), row("00000000-0000-4000-8000-000000000004", null)];
    const out = await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    const events = send.mock.calls[0]![0] as unknown as Array<{ data: { conductor_run_id: string } }>;
    expect(events.map((e) => e.data.conductor_run_id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000004"]);
    expect(out.fanned_out).toBe(2);
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("the cron sweep sends nothing when every active run belongs to another worker", async () => {
    h.rows = [row("00000000-0000-4000-8000-000000000002", OTHER), row("00000000-0000-4000-8000-000000000003", OTHER)];
    const out = await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    expect(send).not.toHaveBeenCalled();
    expect(out).toEqual({ fanned_out: 0 });
  });

  it("the tick handler refuses another worker's run: no tick, no dispatch", async () => {
    h.rows = [row("00000000-0000-4000-8000-000000000002", OTHER)];
    const out = await eventFn({ event: requested("00000000-0000-4000-8000-000000000002"), logger });
    expect(h.tick).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ skipped: true, reason: "other_worker" });
  });

  it("the tick handler still ticks its own run and an unstamped run", async () => {
    h.rows = [row("00000000-0000-4000-8000-000000000001", MINE), row("00000000-0000-4000-8000-000000000004", null)];
    await eventFn({ event: requested("00000000-0000-4000-8000-000000000001"), logger });
    await eventFn({ event: requested("00000000-0000-4000-8000-000000000004"), logger });
    expect(h.tick.mock.calls.map((c) => c[0])).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000004"]);
  });

  it("reads the owner stamp from the run's own graph in the same select", async () => {
    h.rows = [row("00000000-0000-4000-8000-000000000001", MINE)];
    await eventFn({ event: requested("00000000-0000-4000-8000-000000000001"), logger });
    expect(h.selects[0]).toContain("goal_graph");
  });

  it("conductor_owner_only off restores today's behaviour: another worker's run is ticked and swept", async () => {
    h.ownerOnly = false;
    h.rows = [row("00000000-0000-4000-8000-000000000002", OTHER)];
    await eventFn({ event: requested("00000000-0000-4000-8000-000000000002"), logger });
    expect(h.tick).toHaveBeenCalledTimes(1);
    await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    const events = send.mock.calls[0]![0] as unknown as Array<{ data: { conductor_run_id: string } }>;
    expect(events.map((e) => e.data.conductor_run_id)).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });
});
