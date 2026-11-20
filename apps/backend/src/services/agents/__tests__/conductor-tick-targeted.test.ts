import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const REQUESTED = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  queries: [] as Array<Array<[string, ...unknown[]]>>,
  driverDeps: { repairConfig: { enabled: false } } as Record<string, unknown>,
}));

function fillerRows(): Array<{ id: string; tenant_id: string; kind: string }> {
  return Array.from({ length: 25 }, (_, i) => ({
    id: `0000000${i.toString().padStart(2, "0")}-0000-4000-8000-000000000000`,
    tenant_id: "tnt",
    kind: "build_app",
  }));
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: () => {
      const calls: Array<[string, ...unknown[]]> = [];
      h.queries.push(calls);
      const rows = () => {
        if (calls.some((c) => c[0] === "contains")) return [];
        const byId = calls.find(
          (c) => c[0] === "eq" && c[1] === "id",
        ) as ["eq", string, string] | undefined;
        if (!byId) return fillerRows();
        return byId[2] === REQUESTED
          ? [{ id: REQUESTED, tenant_id: "tnt", kind: "build_app" }]
          : [];
      };
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => (calls.push(["select", ...a]), builder),
        eq: (...a: unknown[]) => (calls.push(["eq", ...a]), builder),
        order: (...a: unknown[]) => (calls.push(["order", ...a]), builder),
        not: (...a: unknown[]) => (calls.push(["not", ...a]), builder),
        contains: (...a: unknown[]) => (calls.push(["contains", ...a]), builder),
        limit: (...a: unknown[]) => {
          calls.push(["limit", ...a]);
          return Promise.resolve({ data: rows(), error: null });
        },
        maybeSingle: () =>
          Promise.resolve(
            calls.some((c) => c[0] === "eq" && c[1] === "resource_kind" && c[2] === "domain")
              ? { data: { external_ref: { hostname: "acme-1234abcd.zaviagent.com" } }, error: null }
              : { data: { goal_graph: [] }, error: null },
          ),
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/agents/conductor", () => ({
  conductorTick: h.tick,
}));

vi.mock("@/services/agents/conductor-driver", () => ({
  realConductorTickDeps: h.driverDeps,
  isConductorEnabled: async () => true,
  resolveConductorRepairEnabled: async () => false,
}));

vi.mock("@/services/agents/continue-build", () => ({
  expireStalePausedBuilds: vi.fn(async () => 0),
  resumeStrandedSiteRepublishes: vi.fn(async () => 0),
}));
vi.mock("@/services/agents/conductor-ledger", () => ({
  appendConductorAction: vi.fn().mockResolvedValue(undefined),
  isLoggableTick: () => false,
}));

vi.mock("@/services/agents/conductor-observability", () => ({
  logBuildTick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/agents/cron-stopped", () => ({
  isWorkerCronStopped: () => false,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
}));

import {
  conductorTickFn,
  conductorTickRequestedFn,
  MAX_PARALLEL_CONDUCTOR_TICKS,
} from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";
import type { ConductorTickDeps } from "../conductor";

type Handler = (ctx: {
  event?: unknown;
  logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
}) => Promise<Record<string, unknown>>;

const cronFn = (conductorTickFn as unknown as { fn: Handler }).fn;
const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const handler: Handler = (ctx) =>
  (ctx.event as { name?: string } | undefined)?.name === "conductor/tick.requested"
    ? eventFn(ctx)
    : cronFn(ctx);
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const send = vi.spyOn(inngest, "send");

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
  vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "");
  h.tick.mockReset();
  h.tick.mockResolvedValue({ action: "dispatched", node_id: "n", child_run_id: "c" });
  h.queries.length = 0;
  delete h.driverDeps.screenCheck;
  send.mockReset();
  send.mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("conductor-tick on conductor/tick.requested", () => {
  it("ticks the run that asked, even when 25 older runs would fill the sweep", async () => {
    const out = await handler({
      event: {
        name: "conductor/tick.requested",
        data: { conductor_run_id: REQUESTED },
      },
      logger,
    });

    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.tick.mock.calls[0][0]).toBe(REQUESTED);
    expect(out.ticked).toBe(1);

    const selection = h.queries[0];
    expect(selection).toContainEqual(["eq", "id", REQUESTED]);
    expect(selection.some((c) => c[0] === "order")).toBe(false);
  });

  it("the cron sweeps oldest-first but hands each run to the keyed function instead of ticking inline", async () => {
    const out = await handler({ event: { name: "inngest/scheduled.timer", data: {} }, logger });

    expect(h.tick).not.toHaveBeenCalled();
    const selection = h.queries[0];
    expect(selection).toContainEqual(["order", "updated_at", { ascending: true }]);
    expect(selection.some((c) => c[0] === "eq" && c[1] === "id")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const events = send.mock.calls[0]![0] as unknown as Array<{ name: string; data: { conductor_run_id: string } }>;
    expect(events).toHaveLength(25);
    expect(events.every((e) => e.name === "conductor/tick.requested")).toBe(true);
    expect(new Set(events.map((e) => e.data.conductor_run_id))).toEqual(
      new Set(fillerRows().map((r) => r.id)),
    );
    expect(out).toEqual({ fanned_out: 25 });
  });

  it("a failed fan-out send is reported, never thrown, and ticks nothing", async () => {
    send.mockRejectedValueOnce(new Error("inngest 502"));
    const out = await handler({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    expect(out).toEqual({ fanned_out: 0, error: "inngest 502" });
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("ignores a non-uuid run id without querying or sweeping", async () => {
    const out = await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: "../../etc" } },
      logger,
    });

    expect(out).toEqual({ skipped: true, reason: "no_target" });
    expect(h.queries).toHaveLength(0);
    expect(h.tick).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("a targeted tick hands the post-deploy screen check to its own event instead of awaiting it", async () => {
    const screenCheck = vi.fn();
    h.driverDeps.screenCheck = screenCheck;
    await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: REQUESTED } },
      logger,
    });
    const deps = h.tick.mock.calls[0]![1] as ConductorTickDeps;
    expect(typeof deps.requestScreenCheck).toBe("function");
    await deps.requestScreenCheck!({ tenant_id: "evil", conductor_run_id: REQUESTED, node_id: "deploy" });
    expect(send).toHaveBeenCalledWith({
      name: "build/screen-check.requested",
      data: { conductor_run_id: REQUESTED, node_id: "deploy" },
    });
    expect(screenCheck).not.toHaveBeenCalled();
    send.mockRejectedValueOnce(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      deps.requestScreenCheck!({ tenant_id: "t", conductor_run_id: REQUESTED, node_id: "deploy" }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("a targeted tick wires the static publish request to its own deduped event", async () => {
    await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: REQUESTED } },
      logger,
    });
    const deps = h.tick.mock.calls[0]![1] as ConductorTickDeps;
    const sha = "d".repeat(40);
    await deps.staticPublish!.request({ tenant_id: "tnt", conductor_run_id: REQUESTED, sha });
    expect(send).toHaveBeenCalledWith({
      id: `static-publish:${REQUESTED}:${sha}`,
      name: "build/static-publish.requested",
      data: { tenant_id: "tnt", conductor_run_id: REQUESTED, sha, hostname: "acme-1234abcd.zaviagent.com" },
    });
    expect(typeof deps.staticPublish!.plan).toBe("function");
    expect(typeof deps.staticPublish!.rollback).toBe("function");
  });

  it("with the screen check switched off, no request dep is wired", async () => {
    await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: REQUESTED } },
      logger,
    });
    const deps = h.tick.mock.calls[0]![1] as ConductorTickDeps;
    expect(deps.requestScreenCheck).toBeUndefined();
  });
});

describe("conductor-tick concurrency", () => {
  type Opts = { opts: { concurrency?: unknown; triggers?: Array<{ cron?: string; event?: string }> } };
  const optsOf = (fn: unknown) => (fn as Opts).opts;

  it("the cron sweep keeps its single global slot and fires only on the timer", () => {
    const o = optsOf(conductorTickFn);
    expect(o.triggers).toEqual([{ cron: "*/2 * * * *" }]);
    const list = Array.isArray(o.concurrency) ? o.concurrency : [o.concurrency];
    expect(list[0]).toEqual({ limit: 1 });
  });

  it("targeted ticks run one at a time per conductor run, not one at a time for everyone", () => {
    const o = optsOf(conductorTickRequestedFn);
    expect(o.triggers).toEqual([{ event: "conductor/tick.requested" }]);
    expect(o.concurrency).toEqual([
      { limit: 1, key: "event.data.conductor_run_id" },
      { limit: MAX_PARALLEL_CONDUCTOR_TICKS },
    ]);
  });
});

describe("conductor-tick on a laptop pointed at prod data", () => {
  beforeEach(() => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
  });

  it("does not sweep other tenants' builds on its own cron", async () => {
    const out = await handler({ event: { name: "inngest/scheduled.timer", data: {} }, logger });

    expect(h.tick).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(h.queries).toHaveLength(0);
    expect(out).toEqual({ skipped: true, reason: "not_canonical" });
  });

  it("does not sweep when a bad run id makes the request untargeted", async () => {
    await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: "../../etc" } },
      logger,
    });

    expect(h.tick).not.toHaveBeenCalled();
  });

  it("still advances the one build it asked to tick", async () => {
    await handler({
      event: { name: "conductor/tick.requested", data: { conductor_run_id: REQUESTED } },
      logger,
    });

    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.tick.mock.calls[0][0]).toBe(REQUESTED);
  });

  it("sweeps when the laptop opted into the shared queue on purpose", async () => {
    vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "1");
    await handler({ event: { name: "inngest/scheduled.timer", data: {} }, logger });

    expect((send.mock.calls[0]![0] as unknown as unknown[]).length).toBe(25);
  });
});
