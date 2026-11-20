import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const m = vi.hoisted(() => {
  const state = {
    settings: [] as Array<Record<string, unknown>>,
    insertErrorFor: {} as Record<string, { code?: string; message: string }>,
    existingFor: {} as Record<string, Record<string, unknown> | null>,
    lookupErrorFor: {} as Record<string, { message: string }>,
    lookupThrowsFor: {} as Record<string, boolean>,
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    updateFilters: [] as unknown[][][],
    lookups: [] as unknown[][][],
    liveFor: {} as Record<string, Record<string, unknown> | null>,
    liveErrorFor: {} as Record<string, { message: string }>,
    attachResult: [{ id: "attached" }] as Array<Record<string, unknown>>,
  };
  let nextId = 1;
  const from = (table: string) => {
    if (table === "tenant_meeting_settings") {
      return {
        select: () => ({
          eq: (_col: string, val: unknown) => ({
            then: (resolve: (v: unknown) => unknown) => resolve({ data: state.settings, error: null }),
            maybeSingle: async () => {
              const id = String(val);
              if (state.liveErrorFor[id]) return { data: null, error: state.liveErrorFor[id] };
              if (id in state.liveFor) return { data: state.liveFor[id], error: null };
              const st = state.settings.find((x) => x.tenant_id === id);
              return { data: st ? { enabled: true, meeting_url: st.meeting_url } : null, error: null };
            },
          }),
        }),
      };
    }
    return {
      insert: (row: Record<string, unknown>) => {
        state.inserts.push(row);
        const err = state.insertErrorFor[String(row.tenant_id)];
        return {
          select: () => ({
            maybeSingle: async () => (err ? { data: null, error: err } : { data: { id: `mb-new-${nextId++}` }, error: null }),
          }),
        };
      },
      select: () => {
        const filters: unknown[][] = [];
        state.lookups.push(filters);
        const tenant = () => String((filters.find((f) => f[0] === "tenant_id") ?? [])[1]);
        const chain: Record<string, unknown> = {
          eq: (...a: unknown[]) => {
            filters.push(a);
            return chain;
          },
          maybeSingle: async () => {
            if (state.lookupThrowsFor[tenant()]) throw new Error("socket hang up");
            return { data: state.existingFor[tenant()] ?? null, error: state.lookupErrorFor[tenant()] ?? null };
          },
        };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: unknown[][] = [];
        state.updates.push(patch);
        state.updateFilters.push(filters);
        const chain: Record<string, unknown> = {
          eq: (...a: unknown[]) => (filters.push(a), chain),
          select: async () => ({ data: state.attachResult, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
        };
        return chain;
      },
    };
  };
  const createBot = vi.fn(async (..._a: unknown[]) => ({ id: "recall-bot-1" }));
  const cancelBot = vi.fn(async (..._a: unknown[]): Promise<string> => "removed");
  const logEvent = vi.fn(async (..._a: unknown[]) => undefined);
  return { state, from, createBot, cancelBot, logEvent };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from }) }));
vi.mock("@/services/meetings/recall", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createBot: m.createBot,
  cancelBot: m.cancelBot,
  recallConfigured: () => true,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("../../../workers/client", () => ({
  inngest: { send: vi.fn(), createFunction: (_c: unknown, _t: unknown, handler: unknown) => handler },
}));

import { runMeetingBotScheduler } from "../../../workers/functions/meeting-bot-scheduler";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const LINK = "https://meet.google.com/rab-pitd-bvy";
const FIRST_TICK = new Date("2026-10-27T04:30:10.000Z");
const SECOND_TICK = new Date("2026-10-27T04:38:00.000Z");
const FIRST_TICK_JOIN = "2026-10-27T04:31:10.000Z";
const setting = (over: Row = {}): Row => ({
  tenant_id: "t-1",
  meeting_url: LINK,
  days_of_week: [0, 1, 2, 3, 4, 5, 6],
  join_time: "21:30",
  timezone: "America/Los_Angeles",
  bot_name: "Zavi Notetaker",
  consent_message: "",
  ...over,
});
const DUP = { code: "23505", message: 'duplicate key value violates unique constraint "meeting_bots_scheduled_daily_uniq"' };
const skipLogs = () => m.logEvent.mock.calls.filter((c) => (c[0] as Row).code === "meeting_bot.skipped_same_day");

beforeEach(() => {
  m.state.settings = [setting()];
  m.state.insertErrorFor = {};
  m.state.existingFor = {};
  m.state.lookupErrorFor = {};
  m.state.lookupThrowsFor = {};
  m.state.inserts = [];
  m.state.updates = [];
  m.state.updateFilters = [];
  m.state.lookups = [];
  m.state.liveFor = {};
  m.state.liveErrorFor = {};
  m.state.attachResult = [{ id: "attached" }];
  m.createBot.mockClear();
  m.cancelBot.mockReset();
  m.cancelBot.mockResolvedValue("removed");
  m.logEvent.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("runMeetingBotScheduler", () => {
  it("dispatches today's bot in the join window", async () => {
    const out = await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(out).toEqual({ dispatched: 1 });
    expect(m.state.inserts[0]).toMatchObject({
      tenant_id: "t-1",
      status: "scheduled",
      scheduled_date: "2026-10-26",
      scheduled_for: "2026-10-27T04:30:00.000Z",
      meeting_url: LINK,
    });
    expect(m.createBot.mock.calls[0][0]).toMatchObject({ join_at: "2026-10-27T04:31:10.000Z" });
    expect(m.createBot).toHaveBeenCalledTimes(1);
    expect(m.state.updates[0]).toMatchObject({ provider_bot_id: "recall-bot-1" });
    expect(m.state.updateFilters[0]).toEqual([
      ["id", expect.stringMatching(/^mb-new-/)],
      ["tenant_id", "t-1"],
      ["status", "scheduled"],
    ]);
    expect(m.cancelBot).not.toHaveBeenCalled();
    expect(skipLogs()).toHaveLength(0);
  });

  it("stays quiet on the second tick of the same window (it is the same bot, not a skip)", async () => {
    m.state.insertErrorFor = { "t-1": DUP };
    m.state.existingFor = { "t-1": { id: "mb-1", status: "scheduled", meeting_url: LINK, scheduled_for: FIRST_TICK_JOIN } };
    const out = await runMeetingBotScheduler(logger, SECOND_TICK);
    expect(out).toEqual({ dispatched: 0 });
    expect(m.createBot).not.toHaveBeenCalled();
    expect(skipLogs()).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("skipped"));
  });

  it("logs, with tenant and reason, when a join time moved later today finds today's bot already made", async () => {
    m.state.insertErrorFor = { "t-1": DUP };
    m.state.existingFor = { "t-1": { id: "mb-morning", status: "failed", meeting_url: LINK, scheduled_for: "2026-10-26T16:31:05.000Z" } };
    const out = await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(out).toEqual({ dispatched: 0 });
    expect(m.createBot).not.toHaveBeenCalled();
    expect(skipLogs()).toHaveLength(1);
    const row = skipLogs()[0][0] as Row;
    expect(row).toMatchObject({
      level: "info",
      source: "meeting-bot-scheduler",
      tenant_id: "t-1",
      meta: { skipped_reason: "join_time_changed", object_id: "mb-morning" },
    });
    expect(String(row.message)).toContain("existing_status=failed");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("tenant=t-1 date=2026-10-26 reason=join_time_changed"));
    expect(m.state.lookups[0]).toEqual([
      ["tenant_id", "t-1"],
      ["source", "scheduled"],
      ["scheduled_date", "2026-10-26"],
    ]);
  });

  it("logs when the link changed after today's bot was made in this same window", async () => {
    m.state.insertErrorFor = { "t-1": DUP };
    m.state.existingFor = {
      "t-1": { id: "mb-1", status: "joining", meeting_url: "https://meet.google.com/old-link-xyz", scheduled_for: FIRST_TICK_JOIN },
    };
    await runMeetingBotScheduler(logger, SECOND_TICK);
    expect((skipLogs()[0][0] as Row).meta).toEqual({ skipped_reason: "link_changed_after_scheduling", object_id: "mb-1" });
  });

  it("recognises a duplicate by Postgres code 23505 even when the message wording differs", async () => {
    m.state.insertErrorFor = { "t-1": { code: "23505", message: "conflict" } };
    m.state.existingFor = { "t-1": { id: "mb-old", status: "ingested", meeting_url: LINK, scheduled_for: "2026-10-26T16:31:05.000Z" } };
    await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(skipLogs()).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a late cron tick inside the same window is still the same bot (no false skip)", async () => {
    m.state.insertErrorFor = { "t-1": DUP };
    m.state.existingFor = { "t-1": { id: "mb-1", status: "joining", meeting_url: LINK, scheduled_for: FIRST_TICK_JOIN } };
    await runMeetingBotScheduler(logger, new Date("2026-10-27T04:39:55.000Z"));
    expect(skipLogs()).toHaveLength(0);
  });

  it("catches a join time moved only a few minutes later the same day", async () => {
    m.state.settings = [setting({ join_time: "21:35" })];
    m.state.insertErrorFor = { "t-1": DUP };
    m.state.existingFor = { "t-1": { id: "mb-1", status: "in_call", meeting_url: LINK, scheduled_for: FIRST_TICK_JOIN } };
    await runMeetingBotScheduler(logger, new Date("2026-10-27T04:40:05.000Z"));
    expect((skipLogs()[0][0] as Row).meta).toEqual({ skipped_reason: "join_time_changed", object_id: "mb-1" });
  });

  it("a real insert failure is an error, not a same-day skip", async () => {
    m.state.insertErrorFor = { "t-1": { code: "42501", message: "permission denied for table meeting_bots" } };
    await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("insert failed tenant=t-1"));
    expect(m.state.lookups).toHaveLength(0);
    expect(skipLogs()).toHaveLength(0);
  });

  it("a failed same-day lookup only warns: the next tenant's bot still goes out", async () => {
    m.state.settings = [setting({ tenant_id: "t-1" }), setting({ tenant_id: "t-2" }), setting({ tenant_id: "t-3" })];
    m.state.insertErrorFor = { "t-1": DUP, "t-2": DUP };
    m.state.lookupErrorFor = { "t-1": { message: "timeout" } };
    m.state.lookupThrowsFor = { "t-2": true };
    const out = await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(out).toEqual({ dispatched: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("same-day lookup failed tenant=t-1"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("same-day skip note failed tenant=t-2"));
    expect(m.createBot).toHaveBeenCalledTimes(1);
  });

  it("Notetaker turned off (or the link cleared) after the settings read: the row is cancelled and no Recall bot is made", async () => {
    for (const [live, error] of [
      [{ enabled: false, meeting_url: LINK }, "cancelled_notetaker_off"],
      [{ enabled: true, meeting_url: "" }, "cancelled_link_cleared"],
    ] as const) {
      m.state.updates = [];
      m.createBot.mockClear();
      m.state.liveFor = { "t-1": live };
      const out = await runMeetingBotScheduler(logger, FIRST_TICK);
      expect(out).toEqual({ dispatched: 0 });
      expect(m.createBot).not.toHaveBeenCalled();
      expect(m.state.updates).toEqual([expect.objectContaining({ status: "cancelled", error })]);
    }
  });

  it("fails closed when that settings re-read fails: no bot, row marked failed", async () => {
    m.state.liveErrorFor = { "t-1": { message: "timeout" } };
    const out = await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(out).toEqual({ dispatched: 0 });
    expect(m.createBot).not.toHaveBeenCalled();
    expect(m.state.updates).toEqual([expect.objectContaining({ status: "failed", error: "settings_check_failed" })]);
  });

  it("a save that cancels the row while Recall's bot is being made: the bot is called back, not counted", async () => {
    m.state.attachResult = [];
    const out = await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(out).toEqual({ dispatched: 0 });
    expect(m.cancelBot).toHaveBeenCalledWith("recall-bot-1", { leaveIfInCall: true });
    expect(m.state.updates[1]).toEqual({ provider_bot_id: "recall-bot-1" });
    expect(m.state.updateFilters[1]).toEqual([
      ["id", expect.stringMatching(/^mb-new-/)],
      ["tenant_id", "t-1"],
    ]);
  });

  it("if that call-back fails, the row is marked cancel_failed and the failure is logged", async () => {
    m.state.attachResult = [];
    m.cancelBot.mockRejectedValueOnce(new Error("recall leave call 400: nope"));
    await runMeetingBotScheduler(logger, FIRST_TICK);
    expect(m.state.updates[2]).toMatchObject({ error: "cancel_failed" });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "meeting_bot.cancel_failed", tenant_id: "t-1" }),
    );
  });
});
