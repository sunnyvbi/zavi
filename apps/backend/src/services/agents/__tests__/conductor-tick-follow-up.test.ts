import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RUN = "8059134e-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 8, 29, 10, 0, 7);

const h = vi.hoisted(() => ({
  tick: vi.fn(),
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

import { conductorTickRequestedFn } from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";
import {
  followUpTickEvent,
  FOLLOW_UP_TICK_MIN_DELAY_MS,
  FOLLOW_UP_TICK_BUCKET_MS,
  type FollowUpTickEvent,
} from "../conductor-kick";
import {
  PUSH_GATE_DEFAULT_MAX_WAIT_MS,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
} from "../conductor";

type Handler = (ctx: {
  event?: unknown;
  logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
}) => Promise<Record<string, unknown>>;

const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const send = vi.spyOn(inngest, "send");
const kick = { name: "conductor/tick.requested", data: { conductor_run_id: RUN } };

function sentFollowUps(): FollowUpTickEvent[] {
  return send.mock.calls.flatMap((c) => {
    const arg = c[0] as unknown;
    const list = (Array.isArray(arg) ? arg : [arg]) as Array<Partial<FollowUpTickEvent>>;
    return list.filter((e) => typeof e.ts === "number") as FollowUpTickEvent[];
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.useReal = false;
  h.run = { status: "active", goal_graph: [] };
  for (const k of Object.keys(h.driverDeps)) delete h.driverDeps[k];
  h.driverDeps.repairConfig = { enabled: false };
  h.tick.mockReset();
  send.mockReset();
  send.mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("follow-up tick for a run still waiting after a targeted tick", () => {
  it("schedules exactly one delayed follow-up for the run, 60-90 s out", async () => {
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 1 });
    const out = await eventFn({ event: kick, logger });

    expect(send).toHaveBeenCalledTimes(1);
    const events = sentFollowUps();
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("conductor/tick.requested");
    expect(events[0]!.data).toEqual({ conductor_run_id: RUN });
    expect(events[0]!.ts - T0).toBeGreaterThan(FOLLOW_UP_TICK_MIN_DELAY_MS);
    expect(events[0]!.ts - T0).toBeLessThanOrEqual(FOLLOW_UP_TICK_MIN_DELAY_MS + FOLLOW_UP_TICK_BUCKET_MS);
    expect(events[0]!.id).toContain(RUN);
    expect(out.followed_up).toBe(1);
  });

  it("two ticks inside one bucket send the same event id, so Inngest keeps only one", async () => {
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 1 });
    const bucketStart = Math.floor(T0 / FOLLOW_UP_TICK_BUCKET_MS) * FOLLOW_UP_TICK_BUCKET_MS;
    vi.setSystemTime(bucketStart + 1);
    await eventFn({ event: kick, logger });
    vi.setSystemTime(bucketStart + FOLLOW_UP_TICK_BUCKET_MS - 1);
    await eventFn({ event: kick, logger });
    vi.setSystemTime(bucketStart + FOLLOW_UP_TICK_BUCKET_MS);
    await eventFn({ event: kick, logger });

    const [a, b, c] = sentFollowUps();
    expect(a!.id).toBe(b!.id);
    expect(a!.ts).toBe(b!.ts);
    expect(c!.id).not.toBe(a!.id);
    expect(followUpTickEvent(RUN, bucketStart + 5)).toEqual(a);
    expect(followUpTickEvent("other-run", bucketStart + 5).id).not.toBe(a!.id);
  });

  it.each([
    [{ action: "completed", final: "failed" }],
    [{ action: "completed", final: "paused" }],
    [{ action: "completed", final: "done" }],
    [{ action: "completed_after_repair_exhausted", node_id: "b", root_cause: "x", attempts: 3 }],
    [{ action: "halted" }],
    [{ action: "noop", reason: "failed" }],
  ])("schedules nothing when the tick ended the run: %j", async (r) => {
    h.tick.mockResolvedValue(r);
    const out = await eventFn({ event: kick, logger });
    expect(sentFollowUps()).toHaveLength(0);
    expect(out.followed_up).toBe(0);
  });

  it("schedules nothing for a run that is no longer active", async () => {
    h.run.status = "paused";
    const out = await eventFn({ event: kick, logger });
    expect(h.tick).not.toHaveBeenCalled();
    expect(sentFollowUps()).toHaveLength(0);
    expect(out.followed_up).toBe(0);
  });

  it("a failed follow-up send never fails the tick", async () => {
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 1 });
    send.mockRejectedValueOnce(new Error("inngest 502"));
    const out = await eventFn({ event: kick, logger });
    expect(out.ticked).toBe(1);
    expect(out.followed_up).toBe(0);
  });
});

describe("push gate with no cron: follow-ups alone carry the run to its bound", () => {
  it("a build whose code never lands fails at the 10-min bound instead of waiting forever", async () => {
    h.useReal = true;
    const graph: ConductorNode[] = [
      {
        id: "build",
        status: "dispatched",
        target_agent_slug: "engineer",
        payload: { stage: "build", target: { github_full_name: "Praxis-build/x" } },
        estimate_usd: 3,
        child_run_id: "engineer-child-1",
      },
    ];
    h.run = { status: "active", goal_graph: graph };
    const row = (): ConductorRow => ({
      id: RUN,
      tenant_id: "tnt",
      objective: "build",
      status: h.run.status as ConductorRow["status"],
      max_usd: 100,
      spend_usd: 0,
      kind: "build_app",
      goal_graph: JSON.parse(JSON.stringify(h.run.goal_graph)) as ConductorNode[],
    });
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const setStatus = vi.fn(async (_id: string, status: string) => {
      h.run.status = status;
    });
    const deps: Partial<ConductorTickDeps> = {
      load: vi.fn(async () => row()),
      childStatus: vi.fn(async () => "success" as const),
      consumeBudget: vi.fn(async () => "charged" as const),
      dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
      saveGraph: vi.fn(async (_id: string, g: ConductorNode[]) => {
        h.run.goal_graph = JSON.parse(JSON.stringify(g)) as ConductorNode[];
      }),
      setStatus,
      now: () => Date.now(),
      verifyStagePush,
    };
    Object.assign(h.driverDeps, deps);
    delete h.driverDeps.repairConfig;

    const queue: FollowUpTickEvent[] = [];
    const seen = new Set<string>();
    send.mockImplementation((async (arg: unknown) => {
      const list = (Array.isArray(arg) ? arg : [arg]) as FollowUpTickEvent[];
      for (const e of list) {
        if (typeof e.ts !== "number" || seen.has(e.id)) continue;
        seen.add(e.id);
        queue.push(e);
      }
      return { ids: [] };
    }) as never);

    let ticks = 0;
    await eventFn({ event: kick, logger });
    ticks++;
    while (queue.length > 0 && ticks < 50) {
      queue.sort((x, y) => x.ts - y.ts);
      const next = queue.shift()!;
      expect(next.ts).toBeGreaterThan(Date.now());
      vi.setSystemTime(next.ts);
      await eventFn({ event: next, logger });
      ticks++;
    }

    const node = (h.run.goal_graph as ConductorNode[])[0]!;
    expect(node.status).toBe("failed");
    expect(node.error).toContain("no code reached the provisioned repo");
    expect(h.run.status).toBe("failed");
    expect(setStatus).toHaveBeenCalledWith(RUN, "failed", expect.anything());
    expect(Date.now() - T0).toBeGreaterThan(PUSH_GATE_DEFAULT_MAX_WAIT_MS);
    expect(Date.now() - T0).toBeLessThan(PUSH_GATE_DEFAULT_MAX_WAIT_MS + 2 * 60_000);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(PUSH_GATE_DEFAULT_MAX_WAIT_MS / FOLLOW_UP_TICK_MIN_DELAY_MS) + 2);
    expect(queue).toHaveLength(0);
  });
});
