import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      let order: { col: string; asc: boolean } | null = null;
      let lim = Infinity;
      const pick = () => {
        let out = rows.filter((r) => preds.every((p) => p(r)));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return out.slice(0, lim);
      };
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
        not: (c: string, _op: "is", v: unknown) => (preds.push((r) => (r[c] ?? null) !== v), q),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
        lt: (c: string, v: unknown) => (preds.push((r) => r[c] != null && String(r[c]) < String(v)), q),
        gt: (c: string, v: unknown) => (preds.push((r) => r[c] != null && String(r[c]) > String(v)), q),
        neq: (c: string, v: unknown) => (preds.push((r) => r[c] != null && r[c] !== v), q),
        order: (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), q),
        limit: (n: number) => ((lim = n), q),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        maybeSingle: async () => ({ data: pick()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (patch) {
            const hit = rows.filter((r) => preds.every((p) => p(r)));
            for (const r of hit) Object.assign(r, patch);
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res, rej);
          }
          return Promise.resolve({ data: pick(), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return { tables, posted, sent, db };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => h.db }));
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(async (_t: string, _m: string, body: Record<string, unknown>) => {
    h.posted.push(body);
    return { ok: true };
  }),
}));
vi.mock("../../../workers/client", () => ({
  inngest: {
    send: vi.fn(async (evt: { id?: string; name: string; data: Record<string, unknown> }) => {
      h.sent.push(evt);
      return { ids: [evt.id ?? "evt"] };
    }),
    createFunction: (_c: unknown, _t: unknown, handler: unknown) => handler,
  },
}));

import { runMeetingReconcile } from "../../../workers/functions/meeting-reconcile";
import { meetingNoticeFn } from "../../../workers/functions/meeting-notice";

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: { run: (n: string, fn: () => unknown) => unknown } }) => Promise<unknown>;
async function sweep(at: string) {
  const out = await runMeetingReconcile(logger, new Date(at));
  const results: unknown[] = [];
  for (const evt of h.sent.splice(0)) {
    expect(evt.name).toBe("meeting.notice");
    results.push(await (meetingNoticeFn as unknown as Handler)({ event: { data: evt.data }, step: { run: (_n, fn) => fn() } }));
  }
  return { out, results };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const DEAD = "https://meet.google.com/rab-pitd-bvy";
const origFetch = global.fetch;
const origKey = process.env.RECALL_API_KEY;

let recall: Record<string, unknown> = {};
function recallFetch() {
  global.fetch = vi.fn(async (input: unknown) => {
    const id = String(input).match(/\/bot\/([^/]+)\//)?.[1] ?? "";
    return { ok: true, json: async () => recall[id] } as unknown as Response;
  }) as unknown as typeof fetch;
}
const fatal = (id: string, sub: string, at: string) => ({
  id,
  status_changes: [
    { code: "joining_call", sub_code: null, created_at: at },
    { code: "fatal", sub_code: sub, created_at: at },
  ],
  recordings: [],
});
const waitingTimeout = (id: string, at: string) => ({
  id,
  status_changes: [
    { code: "in_waiting_room", sub_code: null, created_at: at },
    { code: "call_ended", sub_code: "timeout_exceeded_waiting_room", created_at: at },
    { code: "done", sub_code: null, created_at: at },
  ],
  recordings: [],
});
const scheduledBot = (over: Row): Row => ({
  tenant_id: "t1",
  source: "scheduled",
  status: "failed",
  error: null,
  meeting_url: DEAD,
  transcript_chars: 0,
  media_deleted_at: null,
  slack_team_id: null,
  slack_channel_id: null,
  slack_thread_ts: null,
  waiting_notice_at: null,
  failed_notice_at: null,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k];
  h.posted.length = 0;
  h.sent.length = 0;
  process.env.RECALL_API_KEY = "test";
  recall = {};
  recallFetch();
  h.tables.tenant_meeting_settings = [
    { tenant_id: "t1", recap_destination: "slack", slack_channel_id: "C123", meeting_url: DEAD, timezone: "America/Los_Angeles" },
  ];
});
afterEach(() => {
  global.fetch = origFetch;
  process.env.RECALL_API_KEY = origKey;
});

describe("Notetaker failure notice, end to end", () => {
  it("day 1: a dead link keeps meeting_not_found and the team is told to fix the link, dated in their own timezone", async () => {
    h.tables.meeting_bots = [
      scheduledBot({
        id: "d1",
        provider_bot_id: "rb-1",
        error: "meeting_not_found",
        scheduled_date: "2026-10-26",
        scheduled_for: "2026-10-27T04:31:10.050Z",
        updated_at: "2026-10-27T04:31:30.000Z",
      }),
    ];
    recall["rb-1"] = fatal("rb-1", "meeting_not_found", "2026-10-27T04:31:30.000Z");

    const { out, results } = await sweep("2026-10-27T05:15:00.000Z");

    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 1 });
    expect(results).toEqual([{ posted: true }]);
    const row = h.tables.meeting_bots[0];
    expect(row).toMatchObject({ status: "failed", error: "meeting_not_found" });
    expect(row.media_deleted_at).toBeTruthy();
    expect(row.failed_notice_at).toBeTruthy();
    expect(h.posted).toHaveLength(1);
    const unix = Math.floor(Date.parse("2026-10-27T04:31:10.050Z") / 1000);
    expect(h.posted[0]).toMatchObject({
      channel: "C123",
      text: `Zavi Notetaker couldn't join the meeting on <!date^${unix}^{date_short}|Oct 26, 2026, PDT>: no meeting exists at ${DEAD}. Update the link in Notetaker settings.`,
    });
  });

  it("days 2-3: the same dead link, even with the webhook dropped, is recorded specifically but not re-posted", async () => {
    h.tables.meeting_bots = [
      scheduledBot({
        id: "d1",
        provider_bot_id: "rb-1",
        error: "meeting_not_found",
        scheduled_date: "2026-10-26",
        scheduled_for: "2026-10-27T04:31:10.050Z",
        media_deleted_at: "2026-10-27T05:15:00.000Z",
        failed_notice_at: "2026-10-27T05:15:01.000Z",
        updated_at: "2026-10-27T05:15:00.000Z",
      }),
      scheduledBot({
        id: "d2",
        provider_bot_id: "rb-2",
        status: "processing",
        scheduled_date: "2026-10-27",
        scheduled_for: "2026-10-28T04:31:10.000Z",
        updated_at: "2026-10-28T04:31:30.000Z",
      }),
    ];
    recall["rb-2"] = fatal("rb-2", "meeting_not_found", "2026-10-28T04:31:30.000Z");

    const { results } = await sweep("2026-10-28T05:15:00.000Z");

    const d2 = h.tables.meeting_bots.find((r) => r.id === "d2")!;
    expect(d2).toMatchObject({ status: "failed", error: "meeting_not_found" });
    expect(d2.failed_notice_at).toBeTruthy();
    expect(results).toEqual([{ posted: false, reason: "repeat_failure" }]);
    expect(h.posted).toHaveLength(0);
  });

  it("after the link is fixed, a new failure on the new link is a new notice with its own advice", async () => {
    const NEW = "https://meet.google.com/new-link-abc";
    h.tables.tenant_meeting_settings[0].meeting_url = NEW;
    h.tables.meeting_bots = [
      scheduledBot({
        id: "d2",
        provider_bot_id: "rb-2",
        error: "meeting_not_found",
        scheduled_date: "2026-10-27",
        scheduled_for: "2026-10-28T04:31:10.000Z",
        media_deleted_at: "2026-10-28T05:15:00.000Z",
        failed_notice_at: "2026-10-28T05:15:01.000Z",
        updated_at: "2026-10-28T05:15:00.000Z",
      }),
      scheduledBot({
        id: "d3",
        provider_bot_id: "rb-3",
        status: "processing",
        meeting_url: NEW,
        scheduled_date: "2026-10-28",
        scheduled_for: "2026-10-29T04:31:10.000Z",
        updated_at: "2026-10-29T04:41:30.000Z",
      }),
    ];
    recall["rb-3"] = waitingTimeout("rb-3", "2026-10-29T04:41:30.000Z");

    await sweep("2026-10-29T05:30:00.000Z");

    expect(h.tables.meeting_bots.find((r) => r.id === "d3")).toMatchObject({ error: "timeout_exceeded_waiting_room" });
    expect(h.posted).toHaveLength(1);
    expect(String(h.posted[0].text)).toContain("waited to be let into the meeting on");
    expect(String(h.posted[0].text)).toContain("nobody admitted it");
  });

  it("a notice whose event could not be queued is re-sent by a later sweep (the outbox)", async () => {
    h.tables.meeting_bots = [
      scheduledBot({
        id: "d1",
        provider_bot_id: "rb-1",
        error: "meeting_not_found",
        scheduled_date: "2026-10-26",
        scheduled_for: "2026-10-27T04:31:10.050Z",
        updated_at: "2026-10-27T04:31:30.000Z",
      }),
    ];
    recall["rb-1"] = fatal("rb-1", "meeting_not_found", "2026-10-27T04:31:30.000Z");
    const { inngest } = await import("../../../workers/client");
    (inngest.send as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("inngest 503"));

    await sweep("2026-10-27T05:15:00.000Z");
    expect(h.tables.meeting_bots[0]).toMatchObject({ status: "failed", failed_notice_at: null });
    expect(h.posted).toHaveLength(0);

    const { results } = await sweep("2026-10-27T05:45:00.000Z");
    expect(results).toEqual([{ posted: true }]);
    expect(h.posted).toHaveLength(1);
    expect(h.tables.meeting_bots[0].failed_notice_at).toBeTruthy();

    await sweep("2026-10-27T06:15:00.000Z");
    expect(h.posted).toHaveLength(1);
  });

  it("a Slack outage on day 1 is retried by the worker, and is never read as 'told' by day 2", async () => {
    h.tables.meeting_bots = [
      scheduledBot({
        id: "d1",
        provider_bot_id: "rb-1",
        error: "meeting_not_found",
        scheduled_date: "2026-10-26",
        scheduled_for: "2026-10-27T04:31:10.050Z",
        updated_at: "2026-10-27T04:31:30.000Z",
      }),
    ];
    recall["rb-1"] = fatal("rb-1", "meeting_not_found", "2026-10-27T04:31:30.000Z");
    const { slackFetch } = await import("@/services/tools/slack/_client");
    (slackFetch as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void }).mockImplementationOnce(async () => {
      throw new Error("slack 503");
    });

    await runMeetingReconcile(logger, new Date("2026-10-27T05:15:00.000Z"));
    const [evt] = h.sent.splice(0);
    const run = () => (meetingNoticeFn as unknown as Handler)({ event: { data: evt.data }, step: { run: (_n, fn) => fn() } });
    await expect(run()).rejects.toThrow("slack 503");
    expect(h.tables.meeting_bots[0].failed_notice_at).toBeNull();
    await expect(run()).resolves.toEqual({ posted: true });
    expect(h.posted).toHaveLength(1);
  });
});
