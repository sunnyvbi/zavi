import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: vi.fn() }));
vi.mock("@/services/agents/custom-agent-runs", async () => {
  const payload = await import("@/services/agents/custom-agent-payload");
  const actual = await vi.importActual<typeof import("@/services/agents/custom-agent-runs")>(
    "@/services/agents/custom-agent-runs",
  );
  return {
    buildCustomSchedulePayload: payload.buildCustomSchedulePayload,
    resolveCustomDeliver: actual.resolveCustomDeliver,
    recordCustomAgentFailure: vi.fn(),
  };
});

import {
  runCustomAgentSchedules,
  customScheduleDedupeKey,
  type CustomScheduleDeps,
  type CustomTriggerRow,
  type CustomAgentFireRow,
} from "../../../workers/functions/custom-agent-schedules";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const TRIG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function trigger(over: Partial<CustomTriggerRow> = {}): CustomTriggerRow {
  return {
    id: TRIG,
    tenant_id: T1,
    agent_id: AGENT,
    cron: "0 9 * * 1-5",
    tz: "America/Los_Angeles",
    deliver: null,
    next_due_at: null,
    last_result_summary: null,
    ...over,
  };
}

function agent(over: Partial<CustomAgentFireRow> = {}): CustomAgentFireRow {
  return {
    id: AGENT,
    tenant_id: T1,
    slug: "c-abcdef1234",
    status: "active",
    default_deliver: { kind: "chat_thread", thread_id: THREAD },
    ...over,
  };
}

const same = (a: string | null, b: string | null) =>
  a == null || b == null ? a == b : new Date(a).getTime() === new Date(b).getTime();
function makeDeps(rows: CustomTriggerRow[], agents: CustomAgentFireRow[], over: Partial<CustomScheduleDeps> = {}) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const deps: CustomScheduleDeps & { db: typeof db } = {
    db,
    loadTriggers: async (nowIso) =>
      [...db.values()]
        .filter((r) => r.next_due_at == null || new Date(r.next_due_at) <= new Date(nowIso))
        .map((r) => ({ ...r })),
    loadActiveAgents: async (ids) => agents.filter((a) => ids.includes(a.id)),
    claim: vi.fn(async (row, nextDueIso) => {
      const cur = db.get(row.id);
      if (!cur || cur.tenant_id !== row.tenant_id) return false;
      if (!same(cur.next_due_at, row.next_due_at)) return false;
      cur.next_due_at = nextDueIso;
      return true;
    }),
    unclaim: vi.fn(async (row, setIso) => {
      const cur = db.get(row.id);
      if (cur && cur.tenant_id === row.tenant_id && same(cur.next_due_at, setIso)) cur.next_due_at = row.next_due_at;
    }),
    tierAllowed: vi.fn(async () => true),
    enqueue: vi.fn(async () => ({ work_item_id: "wi-1" })),
    recordFailure: vi.fn(async () => null),
    ...over,
  };
  return deps;
}

const run = (bucket: string, deps: CustomScheduleDeps, shells: string[] = [], now?: string) =>
  runCustomAgentSchedules(
    bucket,
    { shellTenantIds: new Set(shells), logger, now: new Date(now ?? new Date(new Date(bucket).getTime() + 30_000).toISOString()) },
    deps,
  );

beforeEach(() => {
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("custom agent schedules: due in the trigger's own zone", () => {
  it("0 9 * * 1-5 in Los Angeles fires at 16:00 UTC in summer (PDT), not at 09:00 UTC", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    expect((await run("2026-09-28T09:00:00.000Z", deps)).fired).toBe(0);
    const r = await run("2026-09-28T16:00:00.000Z", deps);
    expect(r.fired).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledWith({
      tenant_id: T1,
      agent_slug: "c-abcdef1234",
      source: "cron",
      payload: expect.objectContaining({ custom_agent: { trigger_id: TRIG } }),
      dedupe_key: customScheduleDedupeKey(TRIG, "2026-09-28T16:00:00.000Z"),
    });
  });

  it("fires at 17:00 UTC in winter (PST), not at 16:00 UTC", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    expect((await run("2026-12-07T16:00:00.000Z", deps)).fired).toBe(0);
    expect((await run("2026-12-07T17:00:00.000Z", deps)).fired).toBe(1);
  });

  it("does not fire on a weekend", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    expect((await run("2026-09-26T16:00:00.000Z", deps)).fired).toBe(0);
  });

  it("advances next_due_at to the next local fire (DST-aware), past this bucket", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    await run("2026-10-30T16:00:00.000Z", deps);
    expect(deps.db.get(TRIG)!.next_due_at).toBe("2026-11-02T17:00:00.000Z");
  });

  it("an off-grid :07 schedule does NOT fire early at :05; it fires on the first scan at or after :07", async () => {
    const deps = makeDeps([trigger({ cron: "7 9 * * *", next_due_at: "2026-09-28T16:07:00.000Z" })], [agent()]);
    expect((await run("2026-09-28T16:05:00.000Z", deps)).fired).toBe(0);
    const r = await run("2026-09-28T16:10:00.000Z", deps);
    expect(r.fired).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: customScheduleDedupeKey(TRIG, "2026-09-28T16:07:00.000Z") }),
    );
    expect(deps.db.get(TRIG)!.next_due_at).toBe("2026-09-29T16:07:00.000Z");
  });

  it("a next_due_at in the future is not read or fired", async () => {
    const deps = makeDeps([trigger({ next_due_at: "2026-09-29T16:00:00.000Z" })], [agent()]);
    expect((await run("2026-09-28T16:00:00.000Z", deps)).fired).toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("a failed enqueue gives the occurrence back, and the next scan fires it with the same key", async () => {
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("enqueue_work_item failed"))
      .mockResolvedValue({ work_item_id: "wi-2" });
    const deps = makeDeps([trigger({ next_due_at: "2026-09-28T16:00:00.000Z" })], [agent()], { enqueue });
    expect((await run("2026-09-28T16:00:00.000Z", deps)).fired).toBe(0);
    expect(deps.db.get(TRIG)!.next_due_at).toBe("2026-09-28T16:00:00.000Z");
    expect((await run("2026-09-28T16:05:00.000Z", deps)).fired).toBe(1);
    const keys = enqueue.mock.calls.map((c) => (c[0] as { dedupe_key: string }).dedupe_key);
    expect(keys).toEqual([
      customScheduleDedupeKey(TRIG, "2026-09-28T16:00:00.000Z"),
      customScheduleDedupeKey(TRIG, "2026-09-28T16:00:00.000Z"),
    ]);
  });

  it("an unclaim never clobbers a claim another scan made since", async () => {
    const deps = makeDeps([trigger({ next_due_at: "2026-09-28T16:00:00.000Z" })], [agent()]);
    const row = { ...deps.db.get(TRIG)! };
    deps.db.get(TRIG)!.next_due_at = "2026-09-30T16:00:00.000Z";
    await deps.unclaim(row, "2026-09-29T16:00:00.000Z");
    expect(deps.db.get(TRIG)!.next_due_at).toBe("2026-09-30T16:00:00.000Z");
  });
});

describe("custom agent schedules: claim once", () => {
  it("two scanners in the same bucket: only the claimer enqueues", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    const [a, b] = await Promise.all([
      run("2026-09-28T16:00:00.000Z", deps),
      run("2026-09-28T16:00:00.000Z", deps),
    ]);
    expect(a.fired + b.fired).toBe(1);
    expect(a.lostClaim + b.lostClaim).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("custom agent schedules: who never fires", () => {
  it.each(["paused", "draft", "archived"])("a %s agent never fires", async (status) => {
    const deps = makeDeps([trigger()], [agent({ status })]);
    const r = await run("2026-09-28T16:00:00.000Z", deps);
    expect(r.fired).toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("a Free tenant (plan refuses the agent) never fires and the trigger is not claimed", async () => {
    const deps = makeDeps([trigger()], [agent()], { tierAllowed: vi.fn(async () => false) });
    const r = await run("2026-09-28T16:00:00.000Z", deps);
    expect(r).toMatchObject({ fired: 0, skippedPlan: 1 });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("an unreadable plan fails closed", async () => {
    const deps = makeDeps([trigger()], [agent()], {
      tierAllowed: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    expect((await run("2026-09-28T16:00:00.000Z", deps)).fired).toBe(0);
  });

  it("a trigger never pairs with another tenant's agent of the same id", async () => {
    const deps = makeDeps([trigger({ tenant_id: T2 })], [agent({ tenant_id: T1 })]);
    expect((await run("2026-09-28T16:00:00.000Z", deps)).fired).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("a launch-video shell tenant never fires", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    expect((await run("2026-09-28T16:00:00.000Z", deps, [T1])).fired).toBe(0);
  });
});

describe("custom agent schedules: fire-time re-validation", () => {
  it("an invalid stored destination runs nothing and counts one failure", async () => {
    const deps = makeDeps([trigger({ deliver: { kind: "chat_thread", thread_id: "nope" } })], [agent()]);
    const r = await run("2026-09-28T16:00:00.000Z", deps);
    expect(r).toMatchObject({ fired: 0, invalid: 1 });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledTimes(1);
    expect(deps.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: T1, agent_id: AGENT, trigger_id: TRIG }),
    );
  });

  it("a destination field the schema does not allow (an email address) is invalid", async () => {
    const deps = makeDeps([trigger({ deliver: { kind: "email", to: "x@evil.test" } })], [agent()]);
    expect((await run("2026-09-28T16:00:00.000Z", deps)).invalid).toBe(1);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("an invalid zone runs nothing and counts one failure per bucket", async () => {
    const deps = makeDeps([trigger({ tz: "Mars/Olympus" })], [agent()]);
    await run("2026-09-28T16:00:00.000Z", deps);
    await run("2026-09-28T16:00:00.000Z", deps);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("an invalid cron runs nothing and counts a failure", async () => {
    const deps = makeDeps([trigger({ cron: "every day" })], [agent()]);
    await run("2026-09-28T16:00:00.000Z", deps);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("no destination anywhere still runs (the result stays in run history)", async () => {
    const deps = makeDeps([trigger()], [agent({ default_deliver: null })]);
    expect((await run("2026-09-28T16:00:00.000Z", deps)).fired).toBe(1);
  });
});

describe("custom agent schedules: continuity", () => {
  it("the trigger's last_result_summary rides into the next run's payload", async () => {
    const deps = makeDeps([trigger({ last_result_summary: "3 PRs merged yesterday." })], [agent()]);
    await run("2026-09-28T16:00:00.000Z", deps);
    const payload = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as {
      task_description: string;
    };
    expect(payload.task_description).toContain("Since last time");
    expect(payload.task_description).toContain("3 PRs merged yesterday.");
  });

  it("a first run has no Since last time block", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    await run("2026-09-28T16:00:00.000Z", deps);
    const payload = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as {
      task_description: string;
    };
    expect(payload.task_description).not.toContain("Since last time");
  });
});
