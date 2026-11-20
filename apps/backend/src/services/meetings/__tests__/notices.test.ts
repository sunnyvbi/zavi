import { describe, it, expect, vi, beforeEach } from "vitest";

const posted: Array<Record<string, unknown>> = [];
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(async (_t: string, _m: string, body: Record<string, unknown>) => {
    posted.push(body);
    return { ok: true };
  }),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { deliverNotetakerNotice, noticeText, meetingDateToken, failureCause } from "../notices";

type Row = Record<string, unknown>;

function memDb(tables: Record<string, Row[]>, opts: { failPrevLookup?: boolean; failBotRead?: boolean; failMark?: boolean } = {}) {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let order: { col: string; asc: boolean } | null = null;
      let lim = Infinity;
      let usedLt = false;
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
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
        lt: (c: string, v: unknown) => ((usedLt = true), preds.push((r) => r[c] != null && String(r[c]) < String(v)), q),
        order: (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), q),
        limit: (n: number) => ((lim = n), q),
        update: (p: Row) => ((patch = p), q),
        maybeSingle: async () => {
          if (usedLt && opts.failPrevLookup) return { data: null, error: { message: "boom" } };
          if (!usedLt && table === "meeting_bots" && opts.failBotRead) return { data: null, error: { message: "db down" } };
          return { data: pick()[0] ?? null, error: null };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (patch && opts.failMark && "failed_notice_at" in patch) {
            return Promise.resolve({ data: null, error: { message: "write failed" } }).then(res, rej);
          }
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
  } as any;
}

const LINK = "https://meet.google.com/rab-pitd-bvy";
const settings = (over: Row = {}): Row => ({
  tenant_id: "t1",
  recap_destination: "slack",
  slack_channel_id: "C123",
  meeting_url: LINK,
  timezone: "America/Los_Angeles",
  updated_at: "2026-09-08T20:58:28Z",
  ...over,
});
const bot = (over: Row = {}): Row => ({
  id: "b1",
  tenant_id: "t1",
  status: "failed",
  source: "scheduled",
  error: "meeting_not_found",
  meeting_url: LINK,
  scheduled_date: "2026-10-26",
  scheduled_for: "2026-10-27T04:31:10.050Z",
  slack_team_id: null,
  slack_channel_id: null,
  slack_thread_ts: null,
  waiting_notice_at: null,
  failed_notice_at: null,
  ...over,
});
const waitingBot = (over: Row = {}) => bot({ status: "joining", error: null, ...over });

describe("notetaker notices: posting", () => {
  beforeEach(() => {
    posted.length = 0;
  });

  it("posts the waiting notice once to the tenant's default channel for a scheduled bot", async () => {
    const svc = memDb({ meeting_bots: [waitingBot()], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: true });
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: false, reason: "already_posted" });
    expect(posted).toHaveLength(1);
    expect(posted[0].channel).toBe("C123");
    expect(String(posted[0].text)).toContain("waiting room");
  });

  it("skips the waiting notice for a Slack-summoned bot (its thread already says admit it)", async () => {
    const svc = memDb({ meeting_bots: [waitingBot({ slack_channel_id: "C9", slack_thread_ts: "1.2" })], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: false, reason: "not_scheduled" });
    expect(posted).toHaveLength(0);
  });

  it("posts the no-record notice into the summon thread when there is one", async () => {
    const svc = memDb({
      meeting_bots: [bot({ source: "adhoc", error: "no_recording", slack_channel_id: "C9", slack_thread_ts: "1.2" })],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: true });
    expect(posted[0]).toMatchObject({ channel: "C9", thread_ts: "1.2" });
    expect(String(posted[0].text)).toContain("couldn't record");
  });

  it("does nothing when the tenant set no notetaker channel, and marks a failure notice handled so it is not re-sent", async () => {
    const rows = { meeting_bots: [bot()], tenant_meeting_settings: [settings({ slack_channel_id: null })] };
    const svc = memDb(rows);
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: false, reason: "no_channel" });
    expect(posted).toHaveLength(0);
    expect(rows.meeting_bots[0].failed_notice_at).toBeTruthy();
  });

  it("the team channel is used only when the team chose Slack for meeting notes; a summon thread is still answered", async () => {
    for (const recap_destination of [null, "email", "off"]) {
      posted.length = 0;
      const rows = { meeting_bots: [bot()], tenant_meeting_settings: [settings({ recap_destination })] };
      expect(await deliverNotetakerNotice("b1", "no_record", memDb(rows))).toEqual({ posted: false, reason: "no_channel" });
      expect(rows.meeting_bots[0].failed_notice_at).toBeTruthy();
      const waiting = memDb({ meeting_bots: [waitingBot()], tenant_meeting_settings: [settings({ recap_destination })] });
      expect(await deliverNotetakerNotice("b1", "waiting", waiting)).toEqual({ posted: false, reason: "no_channel" });
      expect(posted).toHaveLength(0);
    }
    const thread = memDb({
      meeting_bots: [bot({ source: "adhoc", error: "no_recording", slack_channel_id: "C9", slack_thread_ts: "1.2" })],
      tenant_meeting_settings: [settings({ recap_destination: "off" })],
    });
    expect(await deliverNotetakerNotice("b1", "no_record", thread)).toEqual({ posted: true });
    expect(posted[0]).toMatchObject({ channel: "C9", thread_ts: "1.2" });
  });

  it("a channel added later (a settings edit) still gets the next failure, not folded into the silent one", async () => {
    const day1 = bot({ id: "d1", scheduled_date: "2026-10-26", failed_notice_at: "2026-10-27T05:15:00Z" });
    const day2 = bot({ id: "d2", scheduled_date: "2026-10-27", scheduled_for: "2026-10-28T04:31:00Z" });
    const svc = memDb({ meeting_bots: [day1, day2], tenant_meeting_settings: [settings({ updated_at: "2026-10-27T12:00:00Z" })] });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
  });

  it("a database read error is a retryable failure, never read as 'no bot' or 'already told'", async () => {
    const svc = memDb({ meeting_bots: [bot()], tenant_meeting_settings: [settings()] }, { failBotRead: true });
    await expect(deliverNotetakerNotice("b1", "no_record", svc)).rejects.toThrow(/bot read failed/);
    expect(posted).toHaveLength(0);
  });

  it("skips the waiting notice for an ad-hoc bot even before its thread id is saved (F2)", async () => {
    const svc = memDb({ meeting_bots: [waitingBot({ source: "adhoc" })], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: false, reason: "not_scheduled" });
  });

  it("does not say waiting once the bot is already in the call, e.g. on a late retry (F1)", async () => {
    const svc = memDb({ meeting_bots: [waitingBot({ status: "in_call" })], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: false, reason: "too_late" });
    expect(posted).toHaveLength(0);
  });

  it("marks a failure notice told only after Slack accepted it: a Slack error throws for the retry and marks nothing", async () => {
    const { slackFetch } = await import("@/services/tools/slack/_client");
    (slackFetch as any).mockImplementationOnce(async () => {
      throw new Error("rate_limited");
    });
    const rows = { meeting_bots: [bot()], tenant_meeting_settings: [settings()] };
    const svc = memDb(rows);
    await expect(deliverNotetakerNotice("b1", "no_record", svc)).rejects.toThrow("rate_limited");
    expect(rows.meeting_bots[0].failed_notice_at).toBeNull();
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: true });
    expect(rows.meeting_bots[0].failed_notice_at).toBeTruthy();
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: false, reason: "already_posted" });
    expect(posted).toHaveLength(1);
  });

  it("posted but the told-mark write failed: reports posted and does not throw (a retry would post twice)", async () => {
    const svc = memDb({ meeting_bots: [bot()], tenant_meeting_settings: [settings()] }, { failMark: true });
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: true });
    expect(posted).toHaveLength(1);
  });

  it("a waiting notice is marked only after Slack accepted it, so a retry after a Slack error posts (F3)", async () => {
    const { slackFetch } = await import("@/services/tools/slack/_client");
    (slackFetch as any).mockImplementationOnce(async () => {
      throw new Error("rate_limited");
    });
    const rows = { meeting_bots: [waitingBot()], tenant_meeting_settings: [settings()] };
    const svc = memDb(rows);
    await expect(deliverNotetakerNotice("b1", "waiting", svc)).rejects.toThrow("rate_limited");
    expect(rows.meeting_bots[0].waiting_notice_at).toBeNull();
    expect(await deliverNotetakerNotice("b1", "waiting", svc)).toEqual({ posted: true });
  });

  it("tells a dead-link failure to fix the link, naming the link the bot tried", async () => {
    const svc = memDb({ meeting_bots: [bot()], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("b1", "no_record", svc)).toEqual({ posted: true });
    const text = String(posted[0].text);
    expect(text).toMatch(/^Zavi Notetaker couldn't join the meeting on <!date\^\d+\^\{date_short\}\|[^>]+>: no meeting exists at https:\/\/meet\.google\.com\/rab-pitd-bvy\. Update the link in Notetaker settings\.$/);
    expect(text).not.toContain("access");
  });

  it("does not ask to update a link the team already changed in settings", async () => {
    const svc = memDb({ meeting_bots: [bot()], tenant_meeting_settings: [settings({ meeting_url: "meet.google.com/new-link-abc" })] });
    await deliverNotetakerNotice("b1", "no_record", svc);
    const text = String(posted[0].text);
    expect(text).toContain("no meeting exists at https://meet.google.com/rab-pitd-bvy");
    expect(text).toContain("now has a different link");
    expect(text).not.toContain("Update the link");
  });

  it("dates the meeting by its real instant, rendered in each reader's timezone, with a zone-labelled fallback", async () => {
    const svc = memDb({ meeting_bots: [bot()], tenant_meeting_settings: [settings()] });
    await deliverNotetakerNotice("b1", "no_record", svc);
    const unix = Math.floor(Date.parse("2026-10-27T04:31:10.050Z") / 1000);
    expect(String(posted[0].text)).toContain(`<!date^${unix}^{date_short}|Oct 26, 2026, PDT>`);
    expect(String(posted[0].text)).not.toContain("2026-10-26");
  });
});

describe("notetaker notices: text per reason", () => {
  const on = "<!date^1^{date_short}|Oct 26, 2026, PDT>";

  it("maps Recall sub_codes to what the team should do", () => {
    expect(failureCause("meeting_not_found")).toBe("no_meeting");
    expect(failureCause("meeting_link_invalid")).toBe("no_meeting");
    expect(failureCause("meeting_link_expired")).toBe("link_expired");
    expect(failureCause("timeout_exceeded_waiting_room")).toBe("not_admitted");
    expect(failureCause("call_ended_by_platform_waiting_room_timeout")).toBe("not_admitted");
    expect(failureCause("bot_kicked_from_waiting_room")).toBe("removed");
    expect(failureCause("timeout_exceeded_noone_joined")).toBe("nobody_joined");
    expect(failureCause("bot_kicked_from_call")).toBe("removed_from_call");
    expect(failureCause("meeting_not_started")).toBe("not_started");
    expect(failureCause("meeting_ended")).toBe("already_ended");
    expect(failureCause("call_ended_by_host")).toBe("ended_early");
    expect(failureCause("timeout_exceeded_recording_permission_denied")).toBe("no_permission");
    expect(failureCause("zoom_sdk_credentials_missing")).toBe("our_side");
    expect(failureCause("no_recording")).toBe("unknown");
    expect(failureCause("fatal")).toBe("unknown");
    expect(failureCause(null)).toBe("unknown");
    expect(failureCause("recall create bot 500: boom")).toBe("unknown");
    expect(failureCause("some_new_recall_code")).toBe("platform_reason");
    expect(failureCause("constructor")).toBe("platform_reason");
    expect(failureCause("__proto__")).toBe("unknown");
  });

  it("a waiting-room timeout says nobody admitted it", () => {
    const t = noticeText("no_record", { date: on, reason: "timeout_exceeded_waiting_room", link: "https://meet.google.com/x", scheduled: true });
    expect(t).toContain(`waited to be let into the meeting on ${on}, but nobody admitted it`);
  });

  it("being removed from the waiting room says so, and offers turning Notetaker off only for a settings meeting", () => {
    const sched = noticeText("no_record", { reason: "bot_kicked_from_waiting_room", scheduled: true });
    const adhoc = noticeText("no_record", { reason: "bot_kicked_from_waiting_room", scheduled: false });
    expect(sched).toContain("removed Zavi Notetaker from the waiting room");
    expect(sched).toContain("turn off Notetaker in settings");
    expect(adhoc).toContain("removed Zavi Notetaker from the waiting room");
    expect(adhoc).not.toContain("settings");
  });

  it("an ad-hoc dead link asks to check the link, not to edit settings it never came from", () => {
    const t = noticeText("no_record", { reason: "meeting_not_found", link: "https://zoom.us/j/123", scheduled: false });
    expect(t).toContain("no meeting exists at https://zoom.us/j/123");
    expect(t).toContain("Check the link and send Zavi Notetaker again.");
    expect(t).not.toContain("settings");
  });

  it("an expired link names it", () => {
    const t = noticeText("no_record", { reason: "meeting_link_expired", link: "https://teams.microsoft.com/l/meetup-join/abc", scheduled: true });
    expect(t).toContain("the link https://teams.microsoft.com/l/meetup-join/abc has expired. Update the link in Notetaker settings.");
  });

  it("nobody joined points at the link the team actually uses", () => {
    expect(noticeText("no_record", { reason: "timeout_exceeded_noone_joined", scheduled: true })).toContain(
      "Nobody joined the meeting, so Zavi Notetaker left without recording. If your team meets at a different link, update it in Notetaker settings.",
    );
  });

  it("a failure on Recall's or the platform's side never tells the team to change their link or access", () => {
    for (const code of ["bot_errored", "failed_to_launch_in_time", "zoom_internal_error", "microsoft_teams_call_dropped"]) {
      const t = noticeText("no_record", { reason: code, link: "https://meet.google.com/x", scheduled: true });
      expect(t).toContain("problem on our side, not with your meeting");
      expect(t).not.toContain("access");
      expect(t).not.toContain("Update the link");
    }
  });

  it("a passcode problem asks for the full invite link; a guests-only meeting asks to let guests in", () => {
    expect(noticeText("no_record", { reason: "meeting_password_incorrect", scheduled: true })).toContain(
      "Put the full invite link, with its passcode, in Notetaker settings.",
    );
    expect(noticeText("no_record", { reason: "google_meet_organisation_restricted", scheduled: true })).toContain(
      "Let guests with the link join",
    );
    expect(noticeText("no_record", { reason: "meeting_full", scheduled: true })).toContain("locked or full");
  });

  it("a reason Recall gave but we have no advice for is stated plainly, with no confident advice", () => {
    const t = noticeText("no_record", { reason: "zoom_meeting_host_inactive", scheduled: true });
    expect(t).toContain("The meeting platform's reason: zoom meeting host inactive.");
    expect(t).not.toContain("access");
    expect(t).not.toContain("link");
  });

  it("timing reasons point at the meeting time, not the link", () => {
    expect(noticeText("no_record", { reason: "meeting_not_started", scheduled: true })).toContain(
      "hadn't started yet. If your meeting starts later, update the time in Notetaker settings.",
    );
    expect(noticeText("no_record", { reason: "meeting_ended", scheduled: true })).toContain("it had already ended");
    expect(noticeText("no_record", { reason: "call_ended_by_host", scheduled: true })).toContain("ended before Zavi Notetaker could record");
    expect(noticeText("no_record", { reason: "bot_kicked_from_call" })).toContain("removed Zavi Notetaker from the meeting");
    expect(noticeText("no_record", { reason: "timeout_exceeded_in_call_not_recording" })).toContain("never got permission to record");
  });

  it("keeps the generic advice for a reason it does not know", () => {
    const t = noticeText("no_record", { reason: "no_recording", scheduled: true });
    expect(t).toContain("couldn't record the meeting.");
    expect(t).toContain("Check that the meeting link in Notetaker settings is the one your team uses");
  });

  it("never prints a Zoom passcode, and escapes Slack control characters in the link", () => {
    const t = noticeText("no_record", { reason: "meeting_not_found", link: "https://zoom.us/j/123<b>&x?pwd=SECRET123", scheduled: true });
    expect(t).not.toContain("SECRET123");
    expect(t).not.toContain("pwd");
    expect(t).toContain("https://zoom.us/j/123&lt;b&gt;&amp;x");
  });

  it("omits the date phrase when the meeting time is unknown", () => {
    expect(noticeText("no_record", { reason: "meeting_not_found", link: "https://meet.google.com/x", scheduled: true })).toContain(
      "Zavi Notetaker couldn't join the meeting: no meeting exists",
    );
  });
});

describe("notetaker notices: meeting date", () => {
  const iso = "2026-10-27T04:31:10.050Z";
  const unix = Math.floor(Date.parse(iso) / 1000);

  it("uses the meeting instant so Slack shows each reader their own date; the fallback names the settings zone", () => {
    expect(meetingDateToken(iso, "America/Los_Angeles")).toBe(`<!date^${unix}^{date_short}|Oct 26, 2026, PDT>`);
    expect(meetingDateToken(iso, "Asia/Kolkata")).toBe(`<!date^${unix}^{date_short}|Oct 27, 2026, GMT+5:30>`);
  });

  it("falls back to UTC for a missing or bad timezone, and to no date for a missing time", () => {
    expect(meetingDateToken(iso, "Not/AZone")).toBe(`<!date^${unix}^{date_short}|Oct 27, 2026, UTC>`);
    expect(meetingDateToken(iso, null)).toBe(`<!date^${unix}^{date_short}|Oct 27, 2026, UTC>`);
    expect(meetingDateToken(null, "America/Los_Angeles")).toBeNull();
    expect(meetingDateToken("not a date", "America/Los_Angeles")).toBeNull();
  });
});

describe("notetaker notices: one notice per run of the same failure", () => {
  beforeEach(() => {
    posted.length = 0;
  });

  const day1 = (over: Row = {}) => bot({ id: "d1", scheduled_date: "2026-10-26", scheduled_for: "2026-10-27T04:31:00Z", ...over });
  const day2 = (over: Row = {}) => bot({ id: "d2", scheduled_date: "2026-10-27", scheduled_for: "2026-10-28T04:31:00Z", ...over });
  const day3 = (over: Row = {}) => bot({ id: "d3", scheduled_date: "2026-10-28", scheduled_for: "2026-10-29T04:31:00Z", ...over });

  it("posts the first dead-link failure and folds the next days of the same failure on the same link", async () => {
    const rows = { meeting_bots: [day1(), day2(), day3()], tenant_meeting_settings: [settings()] };
    const svc = memDb(rows);
    expect(await deliverNotetakerNotice("d1", "no_record", svc)).toEqual({ posted: true });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: false, reason: "repeat_failure" });
    expect(await deliverNotetakerNotice("d3", "no_record", svc)).toEqual({ posted: false, reason: "repeat_failure" });
    expect(posted).toHaveLength(1);
    expect(rows.meeting_bots[2].failed_notice_at).toBeTruthy();
    expect(await deliverNotetakerNotice("d3", "no_record", svc)).toEqual({ posted: false, reason: "already_posted" });
  });

  it("posts again when the earlier failure was never actually told (Slack failed or there was no channel)", async () => {
    const svc = memDb({ meeting_bots: [day1({ failed_notice_at: null }), day2()], tenant_meeting_settings: [settings()] });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
  });

  it("posts again when the reason changes (the incident's switch from generic to meeting_not_found)", async () => {
    const svc = memDb({
      meeting_bots: [day1({ error: "no_recording", failed_notice_at: "2026-10-27T05:15:17Z" }), day2()],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
    expect(String(posted[0].text)).toContain("no meeting exists at");
  });

  it("posts again when the link changed", async () => {
    const svc = memDb({
      meeting_bots: [day1({ meeting_url: "https://meet.google.com/old-link-xyz", failed_notice_at: "2026-10-27T05:15:17Z" }), day2()],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
  });

  it("treats scheme, host case, a trailing slash and Meet session params as the same link", async () => {
    const svc = memDb({
      meeting_bots: [
        day1({ meeting_url: "MEET.google.com/rab-pitd-bvy/?authuser=0", failed_notice_at: "2026-10-27T05:15:17Z" }),
        day2(),
      ],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: false, reason: "repeat_failure" });
  });

  it("posts again after a successful meeting broke the streak", async () => {
    const svc = memDb({
      meeting_bots: [
        day1({ failed_notice_at: "2026-10-27T05:15:17Z" }),
        day2({ status: "ingested", error: null }),
        day3(),
      ],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("d3", "no_record", svc)).toEqual({ posted: true });
  });

  it("posts again when Notetaker settings were edited after the earlier notice (maybe a new channel)", async () => {
    const svc = memDb({
      meeting_bots: [day1({ failed_notice_at: "2026-10-27T05:15:17Z" }), day2()],
      tenant_meeting_settings: [settings({ updated_at: "2026-10-27T18:00:00Z", slack_channel_id: "C-NEW" })],
    });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
    expect(posted[0].channel).toBe("C-NEW");
  });

  it("never folds an ad-hoc bot (each pasted link is its own request)", async () => {
    const svc = memDb({
      meeting_bots: [day1({ failed_notice_at: "2026-10-27T05:15:17Z" }), day2({ source: "adhoc" })],
      tenant_meeting_settings: [settings()],
    });
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
  });

  it("posts when the previous-run lookup fails (over-telling beats a silent failure)", async () => {
    const svc = memDb(
      { meeting_bots: [day1({ failed_notice_at: "2026-10-27T05:15:17Z" }), day2()], tenant_meeting_settings: [settings()] },
      { failPrevLookup: true },
    );
    expect(await deliverNotetakerNotice("d2", "no_record", svc)).toEqual({ posted: true });
  });
});
