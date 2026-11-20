import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    auth: { tenant_id: string; user_id: string; access_token: string } | null;
    getResult: { data: Record<string, unknown> | null; error: { message: string } | null };
    priorResult: { data: Record<string, unknown> | null; error: { message: string } | null };
    upsertError: { message: string } | null;
    upserts: Record<string, unknown>[];
    todayBot: { data: Record<string, unknown> | null; error: { message: string } | null };
    pendingBots: Array<Record<string, unknown>>;
    role: string | null;
  } = {
    auth: { tenant_id: "tenant-1", user_id: "user-1", access_token: "token-1" },
    getResult: { data: null, error: null },
    priorResult: { data: null, error: null },
    upsertError: null,
    upserts: [],
    todayBot: { data: null, error: null },
    pendingBots: [],
    role: "owner",
  };

  const requireAuth = vi.fn(async () => state.auth);
  const requireTenantRole = vi.fn(async (_auth: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }, msg?: string) => {
    if (state.role && allowed.includes(state.role)) return true;
    res.status(403).json({ error: { code: "forbidden", message: msg ?? "forbidden" } });
    return false;
  });
  const slackFetch = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, channels: [] }));

  const serverClientFromBearer = vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => state.getResult),
        })),
      })),
    })),
  }));

  const serviceClient = vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "meeting_bots") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          gte: () => chain,
          limit: async () => ({ data: state.pendingBots, error: null }),
          maybeSingle: async () => state.todayBot,
        };
        return chain;
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => state.priorResult),
          })),
        })),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return { error: state.upsertError };
        }),
      };
    }),
  }));

  const cancelSentBots = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ cancelled: 0, failed: 0, kept_in_call: 0 }));
  const logEvent = vi.fn(async (..._a: unknown[]) => undefined);

  return { state, requireAuth, requireTenantRole, slackFetch, serverClientFromBearer, serviceClient, cancelSentBots, logEvent };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.requireTenantRole }));
vi.mock("@/services/supabase", () => ({
  serviceClient: m.serviceClient,
  serverClientFromBearer: m.serverClientFromBearer,
}));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/meetings/cancel-bots", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  cancelSentBots: m.cancelSentBots,
}));

import {
  workspaceNotetakerSettingsGet,
  workspaceNotetakerSettingsPut,
  workspaceNotetakerRecapPut,
  workspaceSlackChannelsGet,
  sameDayNote,
  SAME_DAY_NOTE,
  PENDING_BOT_NOTE,
  CANCELLED_TODAY_NOTE,
} from "../notetaker-settings";
import {
  CANCELLED_NOTE,
  CANCEL_FAILED_MESSAGE,
  CANCEL_CHECK_FAILED_MESSAGE,
  IN_CALL_KEPT_NOTE,
} from "@/services/meetings/cancel-bots";

function mockRes(): Response & { statusCode: number; body?: unknown } {
  const res: Partial<Response> & { statusCode: number; body?: unknown } = {
    statusCode: 200,
  };
  res.status = function status(code: number) {
    res.statusCode = code;
    return res as Response;
  };
  res.json = function json(body: unknown) {
    res.body = body;
    return res as Response;
  };
  return res as Response & { statusCode: number; body?: unknown };
}

const validSettingsBody = {
  enabled: true,
  meeting_url: "",
  days_of_week: [1, 2, 3, 4, 5],
  join_time: "09:30",
  timezone: "America/Los_Angeles",
};

beforeEach(() => {
  m.state.auth = { tenant_id: "tenant-1", user_id: "user-1", access_token: "token-1" };
  m.state.getResult = { data: null, error: null };
  m.state.priorResult = { data: null, error: null };
  m.state.upsertError = null;
  m.state.upserts = [];
  m.state.todayBot = { data: null, error: null };
  m.state.pendingBots = [];
  m.state.role = "owner";
  m.requireAuth.mockClear();
  m.requireTenantRole.mockClear();
  m.slackFetch.mockReset();
  m.slackFetch.mockResolvedValue({ ok: true, channels: [] });
  m.serverClientFromBearer.mockClear();
  m.serviceClient.mockClear();
  m.cancelSentBots.mockReset();
  m.cancelSentBots.mockResolvedValue({ cancelled: 0, failed: 0, kept_in_call: 0 });
  m.logEvent.mockClear();
});

describe("workspace notetaker settings", () => {
  it("returns enabled defaults when the tenant has no settings row: where summaries go is not chosen", async () => {
    const res = mockRes();
    await workspaceNotetakerSettingsGet({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      meeting_url: "",
      bot_name: "Zavi Notetaker",
      recap_destination: null,
      slack_channel_id: null,
    });
    expect((res.body as { consent_message: string }).consent_message).toContain("A summary is shared with your team after the call.");
  });

  it("a member (not owner/admin) cannot change Notetaker settings or list channels", async () => {
    m.state.role = "member";
    const res = mockRes();
    await workspaceNotetakerSettingsPut({ body: validSettingsBody } as unknown as Request, res);
    expect(res.statusCode).toBe(403);
    expect(m.state.upserts).toHaveLength(0);
    const list = mockRes();
    await workspaceSlackChannelsGet({} as Request, list);
    expect(list.statusCode).toBe(403);
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("a schedule save never sets or clears the Slack channel, even when an older client sends one", async () => {
    const res = mockRes();
    await workspaceNotetakerSettingsPut(
      { body: { ...validSettingsBody, slack_channel_id: "C-EVIL", slack_channel_name: "zavi-updates" } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(m.state.upserts[0]).not.toHaveProperty("slack_channel_id");
    expect(m.state.upserts[0]).not.toHaveProperty("slack_channel_name");
    expect(m.state.upserts[0]).not.toHaveProperty("recap_destination");
  });

  it("allows enabled settings with no recurring meeting URL", async () => {
    const res = mockRes();
    await workspaceNotetakerSettingsPut(
      { body: validSettingsBody } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(m.state.upserts[0]).toMatchObject({
      tenant_id: "tenant-1",
      enabled: true,
      meeting_url: "",
    });
  });

  it("tells the team when a same-day time change cannot apply until the next meeting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
    try {
      m.state.priorResult = {
        data: { enabled: true, meeting_url: "https://meet.google.com/abc-defg-hij", join_time: "09:30", timezone: "America/Los_Angeles" },
        error: null,
      };
      m.state.todayBot = { data: { id: "mb-morning" }, error: null };
      const res = mockRes();
      await workspaceNotetakerSettingsPut(
        {
          body: { ...validSettingsBody, meeting_url: "https://meet.google.com/abc-defg-hij", days_of_week: [0, 1, 2, 3, 4, 5, 6], join_time: "21:30" },
        } as unknown as Request,
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, note: SAME_DAY_NOTE });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("saving with Notetaker off or the link cleared cancels the bot already sent", () => {
  const LINK = "https://meet.google.com/abc-defg-hij";
  const priorOn = { enabled: true, meeting_url: LINK, join_time: "09:30", timezone: "America/Los_Angeles", days_of_week: [1, 2, 3, 4, 5] };
  const put = async (body: Record<string, unknown>) => {
    const res = mockRes();
    await workspaceNotetakerSettingsPut({ body: { ...validSettingsBody, ...body } } as unknown as Request, res);
    return res;
  };

  it("turning Notetaker off saves first, then calls back this tenant's sent bots and says so (no 'will still join' warning)", async () => {
    m.state.priorResult = { data: priorOn, error: null };
    m.state.pendingBots = [{ id: "mb-live" }];
    m.cancelSentBots.mockResolvedValue({ cancelled: 1, failed: 0, kept_in_call: 0 });
    const res = await put({ enabled: false, meeting_url: LINK });
    expect(res.statusCode).toBe(200);
    expect(m.state.upserts[0]).toMatchObject({ tenant_id: "tenant-1", enabled: false });
    expect(m.cancelSentBots).toHaveBeenCalledTimes(1);
    expect(m.cancelSentBots.mock.calls[0].slice(1)).toEqual(["tenant-1", "notetaker_off"]);
    expect(res.body).toEqual({ ok: true, note: CANCELLED_NOTE });
    expect(JSON.stringify(res.body)).not.toContain(PENDING_BOT_NOTE);
  });

  it("clearing the link cancels too (link_cleared); a bot already in the call is kept with how to remove it", async () => {
    m.state.priorResult = { data: priorOn, error: null };
    m.cancelSentBots.mockResolvedValue({ cancelled: 0, failed: 0, kept_in_call: 1 });
    const res = await put({ enabled: true, meeting_url: "" });
    expect(m.cancelSentBots.mock.calls[0].slice(1)).toEqual(["tenant-1", "link_cleared"]);
    expect(res.body).toEqual({ ok: true, note: IN_CALL_KEPT_NOTE });
  });

  it("a cancel Recall refused does not fail the save silently: saved, plus the manual-removal message", async () => {
    m.state.priorResult = { data: priorOn, error: null };
    m.cancelSentBots.mockResolvedValue({ cancelled: 0, failed: 1, kept_in_call: 0 });
    const res = await put({ enabled: false, meeting_url: LINK });
    expect(res.statusCode).toBe(200);
    expect(m.state.upserts).toHaveLength(1);
    expect(res.body).toEqual({ ok: true, cancel_error: CANCEL_FAILED_MESSAGE });
  });

  it("a failed lookup is logged and says we could not check", async () => {
    m.cancelSentBots.mockRejectedValue(new Error("live bot lookup failed: timeout"));
    const res = await put({ enabled: false, meeting_url: LINK });
    expect(res.body).toEqual({ ok: true, cancel_error: CANCEL_CHECK_FAILED_MESSAGE });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "meeting_bot.cancel_failed", tenant_id: "tenant-1" }),
    );
  });

  it("other edits keep the warn-only behaviour: no cancel", async () => {
    m.state.priorResult = { data: priorOn, error: null };
    m.state.pendingBots = [{ id: "mb-live" }];
    const res = await put({ enabled: true, meeting_url: LINK, join_time: "10:00" });
    expect(m.cancelSentBots).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, note: PENDING_BOT_NOTE });
  });

  it("a save that is rejected (bad timezone) cancels nothing", async () => {
    const res = await put({ enabled: true, meeting_url: LINK, timezone: "Not/AZone" });
    expect(res.statusCode).toBe(400);
    expect(m.cancelSentBots).not.toHaveBeenCalled();
  });
});

describe("sameDayNote", () => {
  const NOW = new Date("2026-10-27T04:00:00Z");
  const LINK = "https://meet.google.com/abc-defg-hij";
  const EVERY = [0, 1, 2, 3, 4, 5, 6];
  const prior = { enabled: true, meeting_url: LINK, join_time: "09:30", timezone: "America/Los_Angeles", days_of_week: EVERY };
  const next = {
    enabled: true,
    meeting_url: LINK,
    days_of_week: EVERY,
    join_time: "21:30",
    timezone: "America/Los_Angeles",
  };
  function fakeSvc(opts: { pending?: unknown[]; botDates?: string[]; botStatus?: string; error?: { message: string } } = {}) {
    const calls: unknown[][] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (...a: unknown[]) => (calls.push(["eq", ...a]), chain),
      in: (...a: unknown[]) => (calls.push(["in", ...a]), chain),
      gte: (...a: unknown[]) => (calls.push(["gte", ...a]), chain),
      limit: async () => (opts.error ? { data: null, error: opts.error } : { data: opts.pending ?? [], error: null }),
      maybeSingle: async () => {
        if (opts.error) return { data: null, error: opts.error };
        const date = [...calls].reverse().find((c) => c[0] === "eq" && c[1] === "scheduled_date")?.[2];
        return (opts.botDates ?? []).includes(String(date))
          ? { data: { id: "mb-1", ...(opts.botStatus ? { status: opts.botStatus } : {}) }, error: null }
          : { data: null, error: null };
      },
    };
    return { svc: { from: (_t: string) => chain } as never, calls };
  }

  it("notes a changed time when today's scheduled bot already exists and the new time is still ahead today", async () => {
    const { svc, calls } = fakeSvc({ botDates: ["2026-10-26"] });
    expect(await sameDayNote(svc, "tenant-1", prior, next, NOW)).toBe(SAME_DAY_NOTE);
    expect(calls).toContainEqual(["eq", "scheduled_date", "2026-10-26"]);
  });

  it("notes a changed link the same way (today's bot keeps the old one)", async () => {
    const { svc } = fakeSvc({ botDates: ["2026-10-26"] });
    const sameTime = { ...prior, join_time: "21:30" };
    expect(await sameDayNote(svc, "tenant-1", sameTime, { ...next, meeting_url: "https://meet.google.com/new-link-xyz" }, NOW)).toBe(SAME_DAY_NOTE);
  });

  it("warns that a bot sent under the old settings will still join: turned off, link cleared, days or time changed", async () => {
    const pending = [{ id: "mb-live" }];
    const cases = [
      { ...next, join_time: "09:30", enabled: false },
      { ...next, join_time: "09:30", meeting_url: "" },
      { ...next, join_time: "09:30", days_of_week: [2, 3] },
      next,
    ];
    for (const n of cases) {
      const { svc, calls } = fakeSvc({ pending });
      expect(await sameDayNote(svc, "tenant-1", prior, n, NOW)).toBe(PENDING_BOT_NOTE);
      expect(calls).toEqual(
        expect.arrayContaining([
          ["eq", "tenant_id", "tenant-1"],
          ["eq", "source", "scheduled"],
          ["in", "status", ["scheduled", "joining", "in_call"]],
          ["gte", "scheduled_for", new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString()],
        ]),
      );
    }
  });

  it("says nothing when nothing schedule-related changed (even with a bot on its way)", async () => {
    const { svc, calls } = fakeSvc({ pending: [{ id: "mb-live" }], botDates: ["2026-10-26"] });
    expect(await sameDayNote(svc, "tenant-1", { ...prior, join_time: "21:30" }, next, NOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("says nothing when no bot is on its way and today's bot does not exist, or the new time already passed today", async () => {
    const none = fakeSvc({});
    expect(await sameDayNote(none.svc, "tenant-1", prior, next, NOW)).toBeNull();
    const passed = fakeSvc({ botDates: ["2026-10-26"] });
    expect(await sameDayNote(passed.svc, "tenant-1", prior, { ...next, join_time: "20:00" }, NOW)).toBeNull();
    expect(passed.calls).toContainEqual(["eq", "scheduled_date", "2026-10-27"]);
  });

  it("turned back on after today's bot was cancelled: says it starts with the next meeting (Join now for today)", async () => {
    const wasOff = { ...prior, enabled: false, join_time: "21:30" };
    const cancelled = fakeSvc({ botDates: ["2026-10-26"], botStatus: "cancelled" });
    expect(await sameDayNote(cancelled.svc, "tenant-1", wasOff, next, NOW)).toBe(CANCELLED_TODAY_NOTE);
    const moved = fakeSvc({ botDates: ["2026-10-26"], botStatus: "cancelled" });
    expect(await sameDayNote(moved.svc, "tenant-1", prior, next, NOW)).toBe(CANCELLED_TODAY_NOTE);
    expect(await sameDayNote(fakeSvc({}).svc, "tenant-1", wasOff, next, NOW)).toBeNull();
    expect(await sameDayNote(fakeSvc({ botDates: ["2026-10-26"], botStatus: "ingested" }).svc, "tenant-1", wasOff, next, NOW)).toBeNull();
  });

  it("says nothing on a first save, when it was off before and still has no bot, or when the lookups fail", async () => {
    const exists = fakeSvc({ pending: [{ id: "mb-live" }], botDates: ["2026-10-26"] });
    expect(await sameDayNote(exists.svc, "tenant-1", null, next, NOW)).toBeNull();
    const wasOff = fakeSvc({ pending: [{ id: "mb-live" }] });
    expect(await sameDayNote(wasOff.svc, "tenant-1", { ...prior, enabled: false }, { ...next, join_time: "09:30" }, NOW)).toBeNull();
    const broken = fakeSvc({ error: { message: "timeout" } });
    expect(await sameDayNote(broken.svc, "tenant-1", prior, next, NOW)).toBeNull();
  });
});

describe("PUT /api/workspace/notetaker-recap: where meeting summaries go", () => {
  const put = async (body: Record<string, unknown>) => {
    const res = mockRes();
    await workspaceNotetakerRecapPut({ body } as unknown as Request, res);
    return res;
  };
  const slackPages = (pages: Record<string, { channels: Array<Record<string, unknown>>; next?: string }>, joinError?: Error) =>
    m.slackFetch.mockImplementation(async (...a: unknown[]) => {
      const [tenant, method, body] = a as [string, string, Record<string, unknown>];
      expect(tenant).toBe("tenant-1");
      if (method === "conversations.join") {
        if (joinError) throw joinError;
        return { ok: true };
      }
      const p = pages[String(body.cursor ?? "")] ?? { channels: [] };
      return { ok: true, channels: p.channels, response_metadata: { next_cursor: p.next ?? "" } };
    });

  it("403 for a member: nothing saved, Slack never called", async () => {
    m.state.role = "member";
    const res = await put({ destination: "slack", slack_channel: "#standups" });
    expect(res.statusCode).toBe(403);
    expect(m.state.upserts).toHaveLength(0);
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("slack: finds the channel by name on a later page and saves its id for the caller's tenant", async () => {
    slackPages({ "": { channels: [{ id: "C1", name: "general", is_member: true }], next: "c2" }, c2: { channels: [{ id: "C7", name: "standups", is_member: true }] } });
    const res = await put({ destination: "slack", slack_channel: "#Standups" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, recap_destination: "slack", slack_channel_name: "standups" });
    expect(m.state.upserts[0]).toMatchObject({ tenant_id: "tenant-1", recap_destination: "slack", slack_channel_id: "C7", slack_channel_name: "standups" });
  });

  it("slack: a public channel Zavi is not in is joined first", async () => {
    slackPages({ "": { channels: [{ id: "C8", name: "team-notes", is_private: false, is_member: false }] } });
    const res = await put({ destination: "slack", slack_channel: "team-notes" });
    expect(res.statusCode).toBe(200);
    expect(m.slackFetch.mock.calls.map((c) => c[1])).toContain("conversations.join");
    expect(m.state.upserts[0]).toMatchObject({ slack_channel_id: "C8" });
  });

  it("slack: a private channel without Zavi is refused with 'invite @Zavi first', and nothing is saved", async () => {
    slackPages({ "": { channels: [{ id: "C1", name: "general", is_member: true }] } });
    const res = await put({ destination: "slack", slack_channel: "#leads" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "channel_not_found" } });
    expect(JSON.stringify(res.body)).toContain("invite @Zavi to #leads first");
    expect(m.state.upserts).toHaveLength(0);
  });

  it("slack: a public channel Zavi cannot join is refused", async () => {
    slackPages({ "": { channels: [{ id: "C8", name: "team-notes", is_member: false }] } }, new Error("missing_scope"));
    const res = await put({ destination: "slack", slack_channel: "team-notes" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "cannot_join" } });
    expect(m.state.upserts).toHaveLength(0);
  });

  it("slack without a channel name is a 400", async () => {
    const res = await put({ destination: "slack" });
    expect(res.statusCode).toBe(400);
    expect(m.state.upserts).toHaveLength(0);
  });

  it("email and off clear the saved channel so nothing can post to it", async () => {
    for (const destination of ["email", "off"]) {
      m.state.upserts = [];
      const res = await put({ destination, slack_channel: "#ignored" });
      expect(res.statusCode).toBe(200);
      expect(m.state.upserts[0]).toMatchObject({ tenant_id: "tenant-1", recap_destination: destination, slack_channel_id: null, slack_channel_name: null });
    }
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("an unknown destination is a 400", async () => {
    const res = await put({ destination: "everyone" });
    expect(res.statusCode).toBe(400);
    expect(m.state.upserts).toHaveLength(0);
  });
});
