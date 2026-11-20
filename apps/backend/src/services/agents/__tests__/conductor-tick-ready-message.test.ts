import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RUN = "8059134e-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 8, 29, 10, 0, 7);

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  ready: vi.fn(async () => ({ posted: true, thread_id: "t" })),
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
}));

import { conductorTickRequestedFn } from "../../../../workers/functions/conductor-tick";
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
  h.ready.mockClear();
  vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conductor tick posts the build-ready chat message", () => {
  it("asks for the ready message when a build run completes done", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });

    expect(h.ready).toHaveBeenCalledTimes(1);
    expect(h.ready).toHaveBeenCalledWith({ tenant_id: "tnt", conductor_run_id: RUN });
  });

  it.each([
    [{ action: "completed", final: "failed" }],
    [{ action: "completed", final: "paused" }],
    [{ action: "waiting", in_flight: 1 }],
  ])("does not post on %j", async (result) => {
    h.tick.mockResolvedValue(result);
    await eventFn({ event: kick, logger });

    expect(h.ready).not.toHaveBeenCalled();
  });
});
