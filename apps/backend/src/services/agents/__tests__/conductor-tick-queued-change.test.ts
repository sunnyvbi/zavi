import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RUN = "8059134e-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 8, 29, 10, 0, 7);

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  ready: vi.fn(async () => ({ posted: true, thread_id: "t" })),
  drain: vi.fn(async (..._a: unknown[]) => ({ kind: "empty" })),
  drop: vi.fn(async (..._a: unknown[]) => 0),
  note: vi.fn(async (..._a: unknown[]) => undefined),
  useReal: false,
  run: { status: "active" as string, goal_graph: [] as unknown[] },
  driverDeps: { repairConfig: { enabled: false } } as Record<string, unknown>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      const rows = () => {
        if (eqs.some(([k]) => k === "__parked")) return [];
        const wantActive = eqs.some(([k, v]) => k === "status" && v === "active");
        if (wantActive && h.run.status !== "active") return [];
        return [{ id: RUN, tenant_id: "tnt", kind: "build_app" }];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => (eqs.push([k, v]), builder),
        order: () => builder,
        not: () => builder,
        contains: () => (eqs.push(["__parked", true]), builder),
        limit: () => Promise.resolve({ data: rows(), error: null }),
        maybeSingle: () => Promise.resolve({ data: { goal_graph: h.run.goal_graph }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/agents/conductor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conductor")>();
  return {
    ...actual,
    conductorTick: (...a: Parameters<typeof actual.conductorTick>) =>
      h.useReal ? actual.conductorTick(...a) : h.tick(...a),
  };
});

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
vi.mock("@/services/build/build-live-email", () => ({
  maybeSendBuildLiveEmail: vi.fn(async () => {}),
}));
vi.mock("@/services/build/build-ready-message", () => ({
  postBuildReadyMessage: h.ready,
  postBuildChatNote: h.note,
}));

vi.mock("@/services/sites/queued-change", () => ({
  drainQueuedSiteChange: h.drain,
  dropHeldChanges: h.drop,
}));
vi.mock("@/routes/workspace/website-chat", () => ({
  realDrainDeps: async () => ({ marker: "real" }),
}));

import { conductorTickFn, conductorTickRequestedFn } from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";

type Handler = (ctx: {
  event?: unknown;
  logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
}) => Promise<Record<string, unknown>>;

const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const kick = { name: "conductor/tick.requested", data: { conductor_run_id: RUN } };

beforeEach(() => {
  vi.setSystemTime(T0);
  h.run = { status: "active", goal_graph: [] };
  h.tick.mockReset();
  h.drain.mockClear();
  h.drop.mockReset();
  h.drop.mockResolvedValue(0);
  h.note.mockClear();
  vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a finished build starts the change the owner sent while it was building", () => {
  it.each([[{ action: "completed", final: "done" }], [{ action: "completed", final: "failed" }]])(
    "drains this tenant's held change when a build run ends (%j), since either frees the build slot",
    async (result) => {
      h.tick.mockResolvedValue(result);
      await eventFn({ event: kick, logger });
      await vi.waitFor(() => expect(h.drain).toHaveBeenCalledTimes(1));
      expect(h.drain).toHaveBeenCalledWith("tnt", { marker: "real" });
    },
  );

  it("a failed build drops the changes held on it before anything else can start them", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "failed" });
    h.drop.mockResolvedValue(1);
    await eventFn({ event: kick, logger });
    await vi.waitFor(() => expect(h.drain).toHaveBeenCalledTimes(1));
    expect(h.drop).toHaveBeenCalledWith("tnt", RUN);
    expect(h.drop.mock.invocationCallOrder[0]!).toBeLessThan(h.drain.mock.invocationCallOrder[0]!);
  });

  it("a finished build never drops a held change", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });
    await vi.waitFor(() => expect(h.drain).toHaveBeenCalledTimes(1));
    expect(h.drop).not.toHaveBeenCalled();
  });

  it.each([[{ action: "waiting", in_flight: 1 }], [{ action: "dispatched", node_id: "n1" }]])(
    "does not drain while the build is still running (%j)",
    async (result) => {
      h.tick.mockResolvedValue(result);
      await eventFn({ event: kick, logger });
      await new Promise((r) => setTimeout(r, 20));
      expect(h.drain).not.toHaveBeenCalled();
    },
  );

  it("the two-minute sweep retries a change left waiting, once per tenant, and survives a failing drain", async () => {
    h.drain.mockRejectedValueOnce(new Error("db down"));
    const cronFn = (conductorTickFn as unknown as { fn: Handler }).fn;
    vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "1");
    try {
      await cronFn({ logger });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(h.drain).toHaveBeenCalledTimes(1);
    expect(h.drain).toHaveBeenCalledWith("tnt", { marker: "real" });
  });

  it("a requested tick never sweeps", async () => {
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 1 });
    await eventFn({ event: kick, logger });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.drain).not.toHaveBeenCalled();
  });

  it("a drain failure never fails the tick", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    h.drain.mockRejectedValueOnce(new Error("db down"));
    const out = await eventFn({ event: kick, logger });
    expect(out.ticked).toBe(1);
    expect((out.results as Array<{ action: string }>)[0]!.action).toBe("completed");
  });
});
