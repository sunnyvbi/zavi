import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Row = {
  id: string;
  tenant_id: string;
  run_id: string | null;
  notified: boolean | null;
  notification_key: string | null;
  queued_at: string | null;
  created_at: string;
  kind: string;
  need: string[] | null;
};
const notes: Row[] = [];
const runs: Array<{ id: string; tenant_id: string; agent_slug: string; payload: Record<string, unknown> }> = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const rows = (table === "agent_runs" ? runs : notes) as unknown as Array<Record<string, unknown>>;
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const match = () => rows.filter((r) => filters.every((f) => f(r)));
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
        not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), q),
        or: (expr: string) => {
          if (expr === "notified.is.null,notified.eq.false") filters.push((r) => r.notified !== true);
          return q;
        },
        gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          if (patch) for (const r of match()) Object.assign(r, patch);
          return Promise.resolve({ data: patch ? null : match(), error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/growth/goal-owner", () => ({
  enqueueGoalOwnerRun: vi.fn(),
  isNoteVisible: (n: { need?: string[] | null; changed?: string[] | null }) => (n.need?.length ?? 0) + (n.changed?.length ?? 0) > 0,
}));

type Cfg = { onFailure: (ctx: { event: { data: { event: { data: Record<string, unknown> } } } }) => Promise<void>; debounce?: { key: string; period: string; timeout: string } };
type Handler = (ctx: { event: { data: Record<string, unknown> }; step: { run: (n: string, fn: () => unknown) => unknown } }) => Promise<unknown>;
const fns = vi.hoisted(() => ({ list: [] as Array<{ cfg: { id: string }; handler: unknown }> }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (cfg: { id: string }, _t: unknown, handler: unknown) => {
      fns.list.push({ cfg, handler });
      return {};
    },
  },
}));

let settleNoteDelivery: typeof import("../cgo-goal-owner")["settleNoteDelivery"];
let planNoteBatch: typeof import("../cgo-goal-owner")["planNoteBatch"];
beforeAll(async () => {
  ({ settleNoteDelivery, planNoteBatch } = await import("../cgo-goal-owner"));
});
const noteFn = () => fns.list.find((f) => f.cfg.id === "cgo-note-email")!;

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T10:05:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  notes.length = 0;
  runs.length = 0;
  runs.push({ id: "run-1", tenant_id: T, agent_slug: "cgo", payload: { autopilot: true } });
  notes.push(
    { id: "alert", tenant_id: T, run_id: null, notified: false, notification_key: "blocker:x", queued_at: "2026-10-08T10:00:00Z", created_at: "2026-10-08T10:00:00Z", kind: "alarm", need: ["Reconnect Meta Ads"] },
    { id: "review", tenant_id: T, run_id: "run-1", notified: false, notification_key: "review:run-1", queued_at: "2026-10-08T10:00:08Z", created_at: "2026-10-08T10:00:08Z", kind: "founder", need: ["Your call: Sales Search"] },
  );
});

describe("settleNoteDelivery", () => {
  it("a delivered note is told; an undelivered one gives its asks back (key cleared)", async () => {
    await settleNoteDelivery({ note_id: "alert" }, true);
    await settleNoteDelivery({ run_id: "run-1" }, false);
    expect(notes[0]).toMatchObject({ notified: true, notification_key: "blocker:x" });
    expect(notes[1]).toMatchObject({ notified: false, notification_key: null, queued_at: null });
  });

  it("never undoes a delivery already confirmed", async () => {
    await settleNoteDelivery({ note_id: "alert" }, true);
    await settleNoteDelivery({ note_id: "alert" }, false);
    expect(notes[0]).toMatchObject({ notified: true, notification_key: "blocker:x" });
  });

  it("the worker's final failure gives the note's asks back", async () => {
    await (noteFn().cfg as unknown as Cfg).onFailure({ event: { data: { event: { data: { note_id: "alert", tenant_id: T } } } } });
    expect(notes[0]).toMatchObject({ notified: false, notification_key: null });
  });
});

describe("one email per burst", () => {
  it("the worker waits 10 minutes per tenant, never more than 15", () => {
    expect((noteFn().cfg as unknown as Cfg).debounce).toEqual({ key: "event.data.tenant_id", period: "10m", timeout: "15m" });
  });

  it("the batch is every note still waiting for the tenant, the event's own included", async () => {
    notes.push(
      { id: "done", tenant_id: T, run_id: null, notified: true, notification_key: "k:done", queued_at: "2026-10-08T09:00:00Z", created_at: "2026-10-08T09:00:00Z", kind: "alarm", need: ["old"] },
      { id: "silent", tenant_id: T, run_id: null, notified: false, notification_key: null, queued_at: null, created_at: "2026-10-08T10:01:00Z", kind: "alarm", need: ["never queued"] },
      { id: "empty", tenant_id: T, run_id: null, notified: false, notification_key: "k:empty", queued_at: "2026-10-08T10:02:00Z", created_at: "2026-10-08T10:02:00Z", kind: "alarm", need: [] },
      { id: "stale", tenant_id: T, run_id: null, notified: false, notification_key: "k:stale", queued_at: "2026-10-06T10:00:00Z", created_at: "2026-10-06T10:00:00Z", kind: "alarm", need: ["two days old"] },
      { id: "theirs", tenant_id: OTHER, run_id: null, notified: false, notification_key: "k:o", queued_at: "2026-10-08T10:00:00Z", created_at: "2026-10-08T10:00:00Z", kind: "alarm", need: ["other tenant"] },
    );
    expect(await planNoteBatch({ run_id: "run-1" }, NOW)).toEqual([{ note_id: "alert" }, { run_id: "run-1" }]);
  });

  it("a late event whose note was delivered still sends what is waiting; nothing waiting sends nothing", async () => {
    notes[1].notified = true;
    expect(await planNoteBatch({ run_id: "run-1" }, NOW)).toEqual([{ note_id: "alert" }]);
    notes[0].notified = true;
    const run = vi.fn((n: string, fn: () => unknown) => (n === "send" ? { sent: true } : fn()));
    expect(await (noteFn().handler as Handler)({ event: { data: { note_id: "alert", tenant_id: T } }, step: { run } })).toEqual({ skipped: "already_delivered" });
    expect(run.mock.calls.map((c) => c[0])).toEqual(["batch"]);
  });

  it("one send settles every note in it; a send that reached no channel unsettles every one", async () => {
    const handler = noteFn().handler as Handler;
    const none = (n: string, fn: () => unknown) => (n === "send" || n === "slack-dm" ? { sent: false, reason: "no_owner_email" } : fn());
    await handler({ event: { data: { run_id: "run-1", tenant_id: T } }, step: { run: none } });
    expect(notes.map((n) => n.notification_key)).toEqual([null, null]);
    notes[0].notification_key = "blocker:x";
    notes[1].notification_key = "review:run-1";
    notes[0].queued_at = notes[1].queued_at = "2026-10-08T10:00:08Z";
    let emails = 0;
    const sent = (n: string, fn: () => unknown) => (n === "send" ? (emails++, { sent: true }) : n === "slack-dm" ? { sent: false, reason: "no_slack" } : fn());
    expect(await handler({ event: { data: { run_id: "run-1", tenant_id: T } }, step: { run: sent } })).toMatchObject({ notes: 2 });
    expect(notes.map((n) => n.notified)).toEqual([true, true]);
    expect(emails).toBe(1);
  });
});
