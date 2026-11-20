
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: vi.fn() }));
vi.mock("@/services/agents/custom-agent-runs", async () => {
  const payload = await import("@/services/agents/custom-agent-payload");
  const actual = await vi.importActual<typeof import("@/services/agents/custom-agent-runs")>(
    "@/services/agents/custom-agent-runs",
  );
  return {
    buildCustomSchedulePayload: payload.buildCustomSchedulePayload,
    buildCustomWatchPayload: payload.buildCustomWatchPayload,
    resolveCustomDeliver: actual.resolveCustomDeliver,
    recordCustomAgentFailure: vi.fn(),
  };
});

import {
  runCustomAgentWatches,
  watchIntervalMinutes,
  type CustomWatchDeps,
  type CustomWatchRow,
} from "../../../workers/functions/custom-agent-watches";
import type { CustomAgentFireRow } from "../../../workers/functions/custom-agent-schedules";
import { watchContentHash } from "@/services/agents/url-watch";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const TRIG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const URL1 = "https://acme.com/pricing";
const NOW = new Date("2026-09-25T18:00:00.000Z");
const BUCKET = "2026-09-25T18:00:00.000Z";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function trigger(over: Partial<CustomWatchRow> = {}): CustomWatchRow {
  return {
    id: TRIG,
    tenant_id: T1,
    agent_id: AGENT,
    interval_minutes: 30,
    condition: `Tell me when ${URL1} shows a price under $10`,
    deliver: null,
    next_due_at: null,
    last_checked_at: null,
    url_baseline: {},
    last_fingerprint: null,
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

function makeDeps(rows: CustomWatchRow[], agents: CustomAgentFireRow[], page = "$12", over: Partial<CustomWatchDeps> = {}) {
  const db = new Map(rows.map((r) => [r.id, { ...r, last_fired_at: null as string | null }]));
  const deps = {
    db,
    loadTriggers: async (nowIso: string) =>
      [...db.values()]
        .filter((r) => r.next_due_at == null || new Date(r.next_due_at) <= new Date(nowIso))
        .map(({ last_fired_at: _f, ...r }) => ({ ...r })),
    loadActiveAgents: async (ids: string[]) => agents.filter((a) => ids.includes(a.id)),
    claim: vi.fn(async (row: CustomWatchRow, nextDueIso: string, checkedIso: string) => {
      const cur = db.get(row.id);
      if (!cur || cur.tenant_id !== row.tenant_id) return false;
      if (!same(cur.next_due_at, row.next_due_at)) return false;
      cur.next_due_at = nextDueIso;
      cur.last_checked_at = checkedIso;
      return true;
    }),
    unclaim: vi.fn(async (row: CustomWatchRow, setIso: string) => {
      const cur = db.get(row.id);
      if (cur && cur.next_due_at === setIso) cur.next_due_at = row.next_due_at;
    }),
    markFired: vi.fn(async (row: CustomWatchRow, firedIso: string) => {
      const cur = db.get(row.id);
      if (cur) cur.last_fired_at = firedIso;
    }),
    refetch: vi.fn(async () => ({ content: page, ok: true })),
    tierAllowed: vi.fn(async () => true),
    enqueue: vi.fn(async () => ({ id: "w1" })) as unknown as CustomWatchDeps["enqueue"],
    recordFailure: vi.fn(async () => null),
    ...over,
  };
  return deps as typeof deps & CustomWatchDeps;
}

const run = (deps: CustomWatchDeps, now = NOW) =>
  runCustomAgentWatches(BUCKET, { shellTenantIds: new Set(), logger, now }, deps);

describe("runCustomAgentWatches: URL watches", () => {
const enqueued = (deps: CustomWatchDeps) =>
  (deps.enqueue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

  it("first check (empty baseline): runs once, the new hash rides in the payload (stored by the finish hook, not here)", async () => {
    const deps = makeDeps([trigger()], [agent()]);
    const r = await run(deps);
    expect(r.fired).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueued(deps).payload.custom_watch).toEqual({ url_baseline: { [URL1]: watchContentHash("$12") } });
    expect(deps.db.get(TRIG)!.url_baseline).toEqual({});
    expect(deps.db.get(TRIG)!.last_checked_at).toBe(NOW.toISOString());
    expect(deps.db.get(TRIG)!.last_fired_at).toBe(NOW.toISOString());
  });

  it("no change: no run, nothing enqueued, last_checked_at and next_due_at still move", async () => {
    const deps = makeDeps([trigger({ url_baseline: { [URL1]: watchContentHash("$12") } })], [agent()]);
    const r = await run(deps);
    expect(r.noDelta).toBe(1);
    expect(r.fired).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.markFired).not.toHaveBeenCalled();
    const row = deps.db.get(TRIG)!;
    expect(row.last_checked_at).toBe(NOW.toISOString());
    expect(row.next_due_at).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });

  it("changed page: enqueues a check run naming the page, carrying the new hash", async () => {
    const deps = makeDeps([trigger({ url_baseline: { [URL1]: watchContentHash("$15") } })], [agent()], "$9");
    const r = await run(deps);
    expect(r.fired).toBe(1);
    const call = (deps.enqueue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({ tenant_id: T1, agent_slug: "c-abcdef1234", source: "cron", dedupe_key: `custom:${TRIG}:${BUCKET}` });
    expect(call.payload.task_description).toContain(URL1);
    expect(call.payload.task_description).toContain("```watch_result");
    expect(call.payload.custom_agent).toEqual({ trigger_id: TRIG });
    expect(call.payload.custom_watch).toEqual({ url_baseline: { [URL1]: watchContentHash("$9") } });
    expect(deps.db.get(TRIG)!.url_baseline).toEqual({ [URL1]: watchContentHash("$15") });
  });

  it("the run never finishes (failed / skipped for credits): the next scan still sees the change", async () => {
    const old = { [URL1]: watchContentHash("$15") };
    const deps = makeDeps([trigger({ url_baseline: old })], [agent()], "$9");
    await run(deps);
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const r = await run(deps, later);
    expect(r.noDelta).toBe(0);
    expect(r.fired).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(2);
  });

  it("a condition that also points elsewhere runs even when the page is unchanged", async () => {
    const deps = makeDeps(
      [trigger({ condition: `when ${URL1} changes or Stripe refunds spike`, url_baseline: { [URL1]: watchContentHash("$12") } })],
      [agent()],
    );
    const r = await run(deps);
    expect(r.noDelta).toBe(0);
    expect(r.fired).toBe(1);
    expect(deps.refetch).not.toHaveBeenCalled();
  });

  it("a page that could not be re-read runs the check (uncertainty is never 'no change')", async () => {
    const deps = makeDeps([trigger({ url_baseline: { [URL1]: watchContentHash("$12") } })], [agent()], "", {
      refetch: vi.fn(async () => ({ content: "", ok: false })),
    });
    expect((await run(deps)).fired).toBe(1);
  });

  it("a failed enqueue gives the check back and keeps the old hashes", async () => {
    const old = { [URL1]: watchContentHash("$15") };
    const deps = makeDeps([trigger({ next_due_at: "2026-09-25T17:55:00.000Z", url_baseline: old })], [agent()], "$9", {
      enqueue: vi.fn(async () => {
        throw new Error("queue down");
      }) as unknown as CustomWatchDeps["enqueue"],
    });
    const r = await run(deps);
    expect(r.fired).toBe(0);
    expect(deps.db.get(TRIG)!.next_due_at).toBe("2026-09-25T17:55:00.000Z");
    expect(deps.db.get(TRIG)!.url_baseline).toEqual(old);
  });
});

describe("runCustomAgentWatches: non-URL watches", () => {
  it("always enqueues a check run (the agent checks with its tools)", async () => {
    const deps = makeDeps([trigger({ condition: "when Stripe refunds go above 5 in a day" })], [agent()]);
    const r = await run(deps);
    expect(r.fired).toBe(1);
    expect(deps.refetch).not.toHaveBeenCalled();
  });
});

describe("runCustomAgentWatches: due, claim, floor, tenancy", () => {
  it("not due yet: nothing happens", async () => {
    const deps = makeDeps([trigger({ next_due_at: "2026-09-25T18:10:00.000Z" })], [agent()]);
    const r = await runCustomAgentWatches(BUCKET, { shellTenantIds: new Set(), logger, now: NOW }, {
      ...deps,
      loadTriggers: async () => [trigger({ next_due_at: "2026-09-25T18:10:00.000Z" })],
    });
    expect(r.notDue).toBe(1);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("the 15-minute floor holds even if a row says 5", () => {
    expect(watchIntervalMinutes({ interval_minutes: 5 })).toBe(15);
    expect(watchIntervalMinutes({ interval_minutes: null })).toBe(15);
    expect(watchIntervalMinutes({ interval_minutes: 60 })).toBe(60);
  });

  it("next check is scheduled at the floor for a sub-floor row", async () => {
    const deps = makeDeps([trigger({ interval_minutes: 5, condition: "when X" })], [agent()]);
    await run(deps);
    expect(deps.db.get(TRIG)!.next_due_at).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());
  });

  it("two scans at once: only the claimer runs the check", async () => {
    const deps = makeDeps([trigger({ condition: "when X" })], [agent()]);
    await Promise.all([run(deps), run(deps)]);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it("cross-tenant: a trigger in T2 pointing at T1's agent id never runs", async () => {
    const deps = makeDeps([trigger({ tenant_id: T2, condition: "when X" })], [agent({ tenant_id: T1 })]);
    const r = await run(deps);
    expect(r.scanned).toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("a paused agent's watch never runs", async () => {
    const deps = makeDeps([trigger({ condition: "when X" })], [agent({ status: "paused" })]);
    expect((await run(deps)).scanned).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("below the plan: not claimed, not run", async () => {
    const deps = makeDeps([trigger({ condition: "when X" })], [agent()], "$12", { tierAllowed: vi.fn(async () => false) });
    const r = await run(deps);
    expect(r.skippedPlan).toBe(1);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("a malformed stored destination runs nothing and counts a failure", async () => {
    const deps = makeDeps([trigger({ condition: "when X", deliver: { kind: "fax", to: "1" } })], [agent()]);
    const r = await run(deps);
    expect(r.invalid).toBe(1);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledTimes(1);
  });
});
