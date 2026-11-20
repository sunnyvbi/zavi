import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    settings: Record<string, unknown> | null;
    existing: Record<string, unknown> | null;
    activeCount: number;
    inserted: { id: string } | null;
    insertErr: { message: string } | null;
    createBotFails: boolean;
    liveSettings: Record<string, unknown> | null | undefined;
    attachResult: Array<Record<string, unknown>>;
  } = {
    settings: { enabled: true, bot_name: "Zavi Notetaker", consent_message: "consent" },
    existing: null,
    activeCount: 0,
    inserted: { id: "mb-new" },
    insertErr: null,
    createBotFails: false,
    liveSettings: undefined,
    attachResult: [{ id: "mb-new" }],
  };
  let settingsReads = 0;

  const updates: unknown[] = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) {
        const capChain: Record<string, unknown> = {};
        capChain.eq = vi.fn(() => capChain);
        capChain.in = vi.fn(async () => ({ count: state.activeCount }));
        return capChain;
      }
      return chain;
    });
    chain.eq = vi.fn(self);
    chain.in = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.maybeSingle = vi.fn(async () => {
      if (table !== "tenant_meeting_settings") return { data: state.existing, error: null };
      settingsReads += 1;
      return { data: settingsReads > 1 && state.liveSettings !== undefined ? state.liveSettings : state.settings, error: null };
    });
    chain.insert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: state.inserted, error: state.insertErr })),
      })),
    }));
    chain.update = vi.fn((u: unknown) => {
      updates.push(u);
      const upd: Record<string, unknown> = {};
      upd.eq = vi.fn(() => upd);
      upd.select = vi.fn(async () => ({ data: state.attachResult, error: null }));
      upd.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return upd;
    });
    return chain;
  });
  const serviceClient = vi.fn(() => ({ from }));
  const resetReads = () => {
    settingsReads = 0;
  };
  const cancelBot = vi.fn(async (..._args: unknown[]): Promise<string> => "removed");
  const logEvent = vi.fn(async (..._args: unknown[]) => undefined);
  const createBot = vi.fn(async (..._args: unknown[]) => {
    if (state.createBotFails) throw new Error("recall down");
    return { id: "recall-bot-1" };
  });
  return { state, from, serviceClient, createBot, updates, resetReads, cancelBot, logEvent };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("../../services/meetings/recall", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, createBot: m.createBot, cancelBot: m.cancelBot, recallConfigured: () => true };
});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import { joinMeetingNow } from "../../services/meetings/join-now";

const BASE = { tenant_id: "t-1", requested_by: "u-1" };

beforeEach(() => {
  m.state.settings = { enabled: true, bot_name: "Zavi Notetaker", consent_message: "c" };
  m.state.existing = null;
  m.state.activeCount = 0;
  m.state.inserted = { id: "mb-new" };
  m.state.insertErr = null;
  m.state.createBotFails = false;
  m.state.liveSettings = undefined;
  m.state.attachResult = [{ id: "mb-new" }];
  m.resetReads();
  m.updates.length = 0;
  m.createBot.mockClear();
  m.cancelBot.mockClear();
});

describe("joinMeetingNow", () => {
  it("rejects non-meeting URLs hard", async () => {
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://evil.example.com/x" });
    expect(r).toMatchObject({ ok: false, code: "bad_url" });
    expect(m.createBot).not.toHaveBeenCalled();
  });

  it("blocks when the workspace toggle is explicitly off", async () => {
    m.state.settings = { enabled: false };
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: false, code: "not_enabled" });
  });

  it("defaults a missing settings row to enabled", async () => {
    m.state.settings = null;
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: true, meeting_bot_id: "mb-new", deduped: false });
    const call = m.createBot.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.bot_name).toBe("Zavi Notetaker");
    expect(call.consent_message).toContain("brief your AI team");
  });

  it("dedupes onto an active bot for the same canonical URL", async () => {
    m.state.existing = { id: "mb-live", status: "in_call" };
    const r = await joinMeetingNow({
      ...BASE,
      meeting_url: "https://meet.google.com/abc-defg-hij?authuser=0",
    });
    expect(r).toMatchObject({ ok: true, meeting_bot_id: "mb-live", deduped: true });
    expect(m.createBot).not.toHaveBeenCalled();
  });

  it("enforces the active-adhoc cap", async () => {
    m.state.activeCount = 5;
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: false, code: "too_many_active" });
  });

  it("creates the bot immediately (no join_at) on the canonical URL", async () => {
    const r = await joinMeetingNow({
      ...BASE,
      meeting_url: "https://meet.google.com/abc-defg-hij?authuser=0&hs=122",
    });
    expect(r).toMatchObject({ ok: true, meeting_bot_id: "mb-new", deduped: false });
    const call = m.createBot.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(call.join_at).toBeUndefined();
    expect((call.metadata as Record<string, string>).tenant_id).toBe("t-1");
  });

  it("marks the row failed when Recall errors", async () => {
    m.state.createBotFails = true;
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: false, code: "create_failed" });
    expect(JSON.stringify(m.updates)).toContain("failed");
  });

  it("Notetaker turned off between the check and the insert: no bot, the row is cancelled", async () => {
    m.state.liveSettings = { enabled: false };
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: false, code: "not_enabled" });
    expect(m.createBot).not.toHaveBeenCalled();
    expect(m.updates).toEqual([expect.objectContaining({ status: "cancelled", error: "cancelled_notetaker_off" })]);
  });

  it("turned off while Recall's bot was being made: the bot is called back and the join reports it", async () => {
    m.state.attachResult = [];
    const r = await joinMeetingNow({ ...BASE, meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(r).toMatchObject({ ok: false, code: "not_enabled" });
    expect(m.cancelBot).toHaveBeenCalledWith("recall-bot-1", { leaveIfInCall: true });
  });
});
