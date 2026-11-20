import { describe, it, expect, vi } from "vitest";
import {
  deriveDeliverTarget,
  tzOffsetMinutes,
  localWallToUtc,
  localCronToUtc,
  nextCronFire,
  resolveWhen,
  reminderWhenSchema,
  reminderDeliverSchema,
  composePingBody,
  deliverReminderPing,
  isValidTz,
  normalizeCronExpression,
  REMINDER_MIN_SECONDS,
} from "@/services/agents/reminders";

describe("deriveDeliverTarget", () => {
  it("sends the reminder back to the Slack thread the user asked in", () => {
    expect(
      deriveDeliverTarget({
        slack_routing: { channel_id: "C123ABC", thread_ts: "1720000000.000100" },
      }),
    ).toEqual({
      kind: "slack_thread",
      channel_id: "C123ABC",
      thread_ts: "1720000000.000100",
    });
  });

  it("carries team_id for multi-workspace tenants", () => {
    expect(
      deriveDeliverTarget({
        slack_routing: { channel_id: "C1", thread_ts: "1.2", team_id: "T9" },
      }),
    ).toMatchObject({ team_id: "T9" });
  });

  it("falls back to the chat thread on the web surface", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(deriveDeliverTarget({ chat_thread_id: id })).toEqual({
      kind: "chat_thread",
      thread_id: id,
    });
  });

  it("prefers Slack when the run has both (the user is standing in Slack)", () => {
    const t = deriveDeliverTarget({
      chat_thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      slack_routing: { channel_id: "C1", thread_ts: "1.2" },
    });
    expect(t?.kind).toBe("slack_thread");
  });

  it("returns null when the run has no addressable surface (cron turn)", () => {
    expect(deriveDeliverTarget({})).toBeNull();
  });

  it("has NO field a model could use to name a channel", () => {
    const shape = reminderWhenSchema.safeParse({
      kind: "in",
      seconds: 60,
      channel_id: "C-EVIL",
    });
    expect(shape.success).toBe(true);
    expect(shape.success && (shape.data as Record<string, unknown>).channel_id).toBeUndefined();
  });
});

describe("timezone resolution", () => {
  it("knows PDT is UTC-7 in July", () => {
    expect(tzOffsetMinutes("America/Los_Angeles", new Date("2026-07-13T12:00:00Z"))).toBe(-420);
  });

  it("knows PST is UTC-8 in January (DST-correct, not a fixed offset)", () => {
    expect(tzOffsetMinutes("America/Los_Angeles", new Date("2026-01-13T12:00:00Z"))).toBe(-480);
  });

  it("handles a half-hour zone", () => {
    expect(tzOffsetMinutes("Asia/Kolkata", new Date("2026-07-13T12:00:00Z"))).toBe(330);
  });

  it("converts a local wall-clock to the right UTC instant", () => {
    expect(localWallToUtc("2026-07-14T09:00", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-07-14T16:00:00.000Z",
    );
  });

  it("converts a local wall-clock in a positive-offset zone", () => {
    expect(localWallToUtc("2026-07-14T09:00", "Asia/Kolkata")?.toISOString()).toBe(
      "2026-07-14T03:30:00.000Z",
    );
  });

  it("rejects a malformed local time", () => {
    expect(localWallToUtc("tomorrow at nine", "UTC")).toBeNull();
  });

  it("validates IANA zones", () => {
    expect(isValidTz("America/Los_Angeles")).toBe(true);
    expect(isValidTz("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("localCronToUtc", () => {
  const july = new Date("2026-07-13T12:00:00Z");

  it("shifts a daily 9am PT cron into UTC", () => {
    expect(localCronToUtc("0 9 * * *", "America/Los_Angeles", july).cron).toBe("0 16 * * *");
  });

  it("shifts a half-hour zone's minute field too", () => {
    expect(localCronToUtc("0 9 * * *", "Asia/Kolkata", july).cron).toBe("30 3 * * *");
  });

  it("is a no-op for UTC", () => {
    expect(localCronToUtc("0 9 * * 1-5", "UTC", july).cron).toBe("0 9 * * 1-5");
  });

  it("rolls day-of-week back when the hour wraps to the previous UTC day", () => {
    const r = localCronToUtc("0 1 * * 1", "Asia/Kolkata", july);
    expect(r.cron).toBe("30 19 * * 0");
  });

  it("rolls day-of-week forward when the hour wraps to the next UTC day", () => {
    const r = localCronToUtc("0 18 * * 5", "America/Los_Angeles", july);
    expect(r.cron).toBe("0 1 * * 6");
  });

  it("rolls a weekday RANGE across the boundary", () => {
    expect(localCronToUtc("0 18 * * 1-5", "America/Los_Angeles", july).cron).toBe("0 1 * * 2-6");
  });

  it("leaves a wildcard hour alone (already zone-independent)", () => {
    expect(localCronToUtc("*/15 * * * *", "America/Los_Angeles", july).cron).toBe("*/15 * * * *");
  });

  it("surfaces an invalid cron rather than silently mangling it", () => {
    expect(localCronToUtc("not a cron", "UTC", july).error).toBeTruthy();
  });
});

describe("nextCronFire", () => {
  it("finds the next matching UTC minute", () => {
    const next = nextCronFire("0 16 * * *", new Date("2026-07-13T15:59:00Z"));
    expect(next?.toISOString()).toBe("2026-07-13T16:00:00.000Z");
  });

  it("rolls to tomorrow when today's slot has passed", () => {
    const next = nextCronFire("0 16 * * *", new Date("2026-07-13T16:30:00Z"));
    expect(next?.toISOString()).toBe("2026-07-14T16:00:00.000Z");
  });

  it("is strictly after `after` (never returns the instant it was given)", () => {
    const at = new Date("2026-07-13T16:00:00Z");
    expect(nextCronFire("0 16 * * *", at)?.getTime()).toBeGreaterThan(at.getTime());
  });
});

describe("resolveWhen", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("resolves the screenshot case: 'remind me after 1min'", () => {
    const r = resolveWhen({ kind: "in", seconds: 60 }, "America/Los_Angeles", now);
    expect(r.ok).toBe(true);
    expect(r.ok && r.resolved.schedule_kind).toBe("once");
    expect(r.ok && r.resolved.due_at.toISOString()).toBe("2026-07-13T12:01:00.000Z");
  });

  it("rejects a sub-minute reminder at the schema (cron granularity is 1 min)", () => {
    expect(reminderWhenSchema.safeParse({ kind: "in", seconds: 30 }).success).toBe(false);
    expect(
      reminderWhenSchema.safeParse({ kind: "in", seconds: REMINDER_MIN_SECONDS }).success,
    ).toBe(true);
  });

  it("resolves a local wall-clock into UTC", () => {
    const r = resolveWhen({ kind: "at", local_time: "2026-07-14T09:00" }, "America/Los_Angeles", now);
    expect(r.ok && r.resolved.due_at.toISOString()).toBe("2026-07-14T16:00:00.000Z");
  });

  it("refuses a time in the past instead of firing immediately", () => {
    const r = resolveWhen({ kind: "at", local_time: "2026-07-12T09:00" }, "UTC", now);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/past/i);
  });

  it("resolves a recurring local cron to a UTC cron + the next fire", () => {
    const r = resolveWhen({ kind: "recurring", cron: "0 9 * * *" }, "America/Los_Angeles", now);
    expect(r.ok).toBe(true);
    expect(r.ok && r.resolved.cron_expression).toBe("0 16 * * *");
    expect(r.ok && r.resolved.due_at.toISOString()).toBe("2026-07-13T16:00:00.000Z");
  });

  it("rejects a too-frequent cadence (inherits cron-match's 5-min floor)", () => {
    const r = resolveWhen({ kind: "recurring", cron: "* * * * *" }, "UTC", now);
    expect(r.ok).toBe(false);
  });
});

describe("deliverReminderPing", () => {
  const deps = () => ({
    postToThread: vi.fn(async () => null),
    postToSlack: vi.fn(async () => null),
    scrub: (t: string) => t,
  });

  it("posts the ping into the Slack thread it was asked in", async () => {
    const d = deps();
    const err = await deliverReminderPing(
      {
        tenant_id: "t1",
        note: "check the ads spend",
        deliver: { kind: "slack_thread", channel_id: "C1", thread_ts: "1.2" },
      },
      d,
    );
    expect(err).toBeNull();
    expect(d.postToSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C1",
        thread_ts: "1.2",
        text: "⏰ Reminder: check the ads spend",
      }),
    );
    expect(d.postToThread).not.toHaveBeenCalled();
  });

  it("posts into the chat thread on the web surface", async () => {
    const d = deps();
    await deliverReminderPing(
      {
        tenant_id: "t1",
        note: "standup",
        deliver: { kind: "chat_thread", thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      },
      d,
    );
    expect(d.postToThread).toHaveBeenCalled();
    expect(d.postToSlack).not.toHaveBeenCalled();
  });

  it("refuses a malformed target instead of guessing a destination", async () => {
    const d = deps();
    const err = await deliverReminderPing(
      { tenant_id: "t1", note: "x", deliver: { kind: "slack_thread", channel_id: "not-a-channel" } },
      d,
    );
    expect(err).toMatch(/malformed/);
    expect(d.postToSlack).not.toHaveBeenCalled();
    expect(d.postToThread).not.toHaveBeenCalled();
  });

  it("runs the note through the egress scrub", async () => {
    const d = { ...deps(), scrub: vi.fn((t: string) => t.replace("secret", "[redacted]")) };
    await deliverReminderPing(
      {
        tenant_id: "t1",
        note: "the secret thing",
        deliver: { kind: "slack_channel", channel_id: "C1" },
      },
      d,
    );
    expect(d.scrub).toHaveBeenCalled();
    expect(d.postToSlack).toHaveBeenCalledWith(
      expect.objectContaining({ text: "⏰ Reminder: the [redacted] thing" }),
    );
  });

  it("composePingBody reads like a person, not a system", () => {
    expect(composePingBody("check the ads")).toBe("⏰ Reminder: check the ads");
  });

  it("rejects a chat_thread target whose thread_id is not a uuid", () => {
    expect(
      reminderDeliverSchema.safeParse({ kind: "chat_thread", thread_id: "../../etc/passwd" })
        .success,
    ).toBe(false);
  });
});

describe("deriveDeliverTarget — DM default + chat surfaces", () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("DMs the requester instead of replying in the channel they asked from", () => {
    expect(
      deriveDeliverTarget({
        slack_routing: { channel_id: "C123ABC", thread_ts: "1720000000.000100", team_id: "T9" },
        slack_user_id: "U0ABCDEF",
      }),
    ).toEqual({
      kind: "slack_dm",
      slack_user_id: "U0ABCDEF",
      team_id: "T9",
      fallback: {
        kind: "slack_thread",
        channel_id: "C123ABC",
        thread_ts: "1720000000.000100",
        team_id: "T9",
      },
    });
  });

  it("keeps the thread target when the run has no resolved requester", () => {
    expect(
      deriveDeliverTarget({ slack_routing: { channel_id: "C1", thread_ts: "1.2" } }),
    ).toMatchObject({ kind: "slack_thread" });
  });

  it("ignores a malformed Slack user id rather than storing a bad DM target", () => {
    expect(
      deriveDeliverTarget({
        slack_routing: { channel_id: "C1", thread_ts: "1.2" },
        slack_user_id: "not-a-slack-id",
      }),
    ).toMatchObject({ kind: "slack_thread" });
  });

  it("delivers to WhatsApp when the ask arrived there", () => {
    expect(
      deriveDeliverTarget({
        chat_routing: { kind: "whatsapp", wa_id: "15551234567", phone_number_id: "PN1" },
      }),
    ).toEqual({ kind: "whatsapp", wa_id: "15551234567", phone_number_id: "PN1" });
  });

  it("refuses a discord target with no guild to revalidate against", () => {
    expect(
      deriveDeliverTarget({ chat_routing: { kind: "discord", channel_id: "D1" } as never }),
    ).toBeNull();
  });

  it("delivers to Telegram and Discord", () => {
    expect(deriveDeliverTarget({ chat_routing: { kind: "telegram", chat_id: -100123 } })).toEqual({
      kind: "telegram",
      chat_id: -100123,
    });
    expect(
      deriveDeliverTarget({
        chat_routing: { kind: "discord", channel_id: "D1", guild_id: "G1" },
      }),
    ).toEqual({ kind: "discord", channel_id: "D1", guild_id: "G1" });
  });

  it("prefers the chat surface the user is standing in over a web thread", () => {
    expect(
      deriveDeliverTarget({
        chat_thread_id: uuid,
        chat_routing: { kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" },
      }),
    ).toMatchObject({ kind: "whatsapp" });
  });

  it("every new target shape survives the schema the worker re-parses with", () => {
    for (const t of [
      { kind: "slack_dm", slack_user_id: "U1ABC", fallback: { kind: "slack_thread", channel_id: "C1", thread_ts: "1.2" } },
      { kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" },
      { kind: "telegram", chat_id: -100123 },
      { kind: "discord", channel_id: "D1", guild_id: "G1" },
    ]) {
      expect(reminderDeliverSchema.safeParse(t).success).toBe(true);
    }
  });
});

describe("reminder delivery — per surface", () => {
  const sender = () => vi.fn(async (): Promise<string | null> => null);
  const deps = () => ({
    scrub: (t: string) => t,
    postToThread: sender(),
    postToSlack: sender(),
    postToSlackDm: sender(),
    postToWhatsApp: sender(),
    postToTelegram: sender(),
    postToDiscord: sender(),
  });

  it("posts a DM without touching the channel", async () => {
    const d = deps();
    const err = await deliverReminderPing(
      { tenant_id: "t1", note: "standup", deliver: { kind: "slack_dm", slack_user_id: "U1ABC" } },
      d,
    );
    expect(err).toBeNull();
    expect(d.postToSlackDm).toHaveBeenCalledTimes(1);
    expect(d.postToSlack).not.toHaveBeenCalled();
  });

  it("falls back to the originating thread when the DM cannot be delivered", async () => {
    const d = deps();
    d.postToSlackDm = vi.fn(async (): Promise<string | null> => "missing_scope");
    const err = await deliverReminderPing(
      {
        tenant_id: "t1",
        note: "standup",
        deliver: {
          kind: "slack_dm",
          slack_user_id: "U1ABC",
          fallback: { kind: "slack_thread", channel_id: "C1", thread_ts: "1.2" },
        },
      },
      d,
    );
    expect(err).toBeNull();
    expect(d.postToSlack).toHaveBeenCalledTimes(1);
  });

  it("reports both failures when the DM and its fallback fail", async () => {
    const d = deps();
    d.postToSlackDm = vi.fn(async (): Promise<string | null> => "missing_scope");
    d.postToSlack = vi.fn(async (): Promise<string | null> => "channel_not_found");
    const err = await deliverReminderPing(
      {
        tenant_id: "t1",
        note: "standup",
        deliver: {
          kind: "slack_dm",
          slack_user_id: "U1ABC",
          fallback: { kind: "slack_thread", channel_id: "C1", thread_ts: "1.2" },
        },
      },
      d,
    );
    expect(err).toMatch(/missing_scope/);
    expect(err).toMatch(/channel_not_found/);
  });

  it("routes each chat surface to its own sender", async () => {
    const d = deps();
    await deliverReminderPing(
      { tenant_id: "t1", note: "x", deliver: { kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" } },
      d,
    );
    await deliverReminderPing(
      { tenant_id: "t1", note: "x", deliver: { kind: "telegram", chat_id: 42 } },
      d,
    );
    await deliverReminderPing(
      { tenant_id: "t1", note: "x", deliver: { kind: "discord", channel_id: "D1", guild_id: "G1" } },
      d,
    );
    expect(d.postToWhatsApp).toHaveBeenCalledTimes(1);
    expect(d.postToTelegram).toHaveBeenCalledTimes(1);
    expect(d.postToDiscord).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when no sender is wired for a target", async () => {
    const err = await deliverReminderPing(
      { tenant_id: "t1", note: "x", deliver: { kind: "telegram", chat_id: 42 } },
      { scrub: (t: string) => t, postToThread: vi.fn(async () => null), postToSlack: vi.fn(async () => null) },
    );
    expect(err).toMatch(/no telegram sender/);
  });
});

describe("tzOffsetMinutes / cron normalization", () => {
  it("returns whole minutes even when the instant carries milliseconds", () => {
    const off = tzOffsetMinutes("America/Los_Angeles", new Date("2026-09-08T12:34:56.789Z"));
    expect(Number.isInteger(off)).toBe(true);
  });

  it("produces an integer cron minute (prod row 5acb3f0a was 0.00804…)", () => {
    const { cron } = localCronToUtc(
      "0 9 * * 1",
      "America/Los_Angeles",
      new Date("2026-09-08T12:34:56.789Z"),
    );
    expect(cron).toBe("0 16 * * 1");
  });

  it("normalizes a legacy fractional expression back to a whole minute", () => {
    expect(normalizeCronExpression("0.008049999999911961 16 * * 1")).toBe("0 16 * * 1");
    expect(normalizeCronExpression("*/5 9 * * 1-5")).toBe("*/5 9 * * 1-5");
  });
});
