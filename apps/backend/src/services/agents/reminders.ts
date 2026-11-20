
import { z } from "zod";
import { cronMatches, validateCronExpression } from "../../../workers/functions/cron-match";

export const REMINDER_NOTE_MAX = 2000;
export const REMINDER_PENDING_CAP = 50;
export const REMINDER_MIN_SECONDS = 60;
export const REMINDER_MAX_SECONDS = 365 * 24 * 3600;

const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const slackThreadTarget = z.object({
  kind: z.literal("slack_thread"),
  channel_id: z.string().regex(SLACK_CHANNEL_RE),
  thread_ts: z.string().min(1),
  team_id: z.string().optional(),
});

export const slackChannelTarget = z.object({
  kind: z.literal("slack_channel"),
  channel_id: z.string().regex(SLACK_CHANNEL_RE),
  team_id: z.string().optional(),
});

export const chatThreadTarget = z.object({
  kind: z.literal("chat_thread"),
  thread_id: z.string().regex(UUID_RE),
});

export const slackDmTarget = z.object({
  kind: z.literal("slack_dm"),
  slack_user_id: z.string().regex(SLACK_USER_RE),
  team_id: z.string().optional(),
  fallback: z.union([slackThreadTarget, slackChannelTarget]).optional(),
});

export const whatsappTarget = z.object({
  kind: z.literal("whatsapp"),
  wa_id: z.string().min(1),
  phone_number_id: z.string().min(1),
});

const imessageTarget = z.object({
  kind: z.literal("imessage"),
  line: z.string().min(1),
  handle: z.string().min(1),
});

export const telegramTarget = z.object({
  kind: z.literal("telegram"),
  chat_id: z.union([z.number(), z.string().min(1)]),
});

export const discordTarget = z.object({
  kind: z.literal("discord"),
  channel_id: z.string().min(1),
  guild_id: z.string().min(1),
});

export const reminderDeliverSchema = z.union([
  chatThreadTarget,
  slackDmTarget,
  whatsappTarget,
  imessageTarget,
  telegramTarget,
  discordTarget,
  slackThreadTarget,
  slackChannelTarget,
]);

export type ReminderDeliver = z.infer<typeof reminderDeliverSchema>;

export type ReminderChatRouting =
  | { kind: "whatsapp"; wa_id: string; phone_number_id: string }
  | { kind: "imessage"; line: string; handle: string }
  | { kind: "telegram"; chat_id: number | string }
  | { kind: "discord"; channel_id: string; guild_id: string };

export type ReminderRunCtx = {
  chat_thread_id?: string;
  slack_routing?: {
    channel_id: string;
    thread_ts: string;
    team_id?: string;
  };
  slack_user_id?: string;
  chat_routing?: ReminderChatRouting;
};

export function deriveDeliverTarget(ctx: ReminderRunCtx): ReminderDeliver | null {
  if (ctx.slack_routing?.channel_id && ctx.slack_routing.thread_ts) {
    const thread: ReminderDeliver = {
      kind: "slack_thread",
      channel_id: ctx.slack_routing.channel_id,
      thread_ts: ctx.slack_routing.thread_ts,
      ...(ctx.slack_routing.team_id ? { team_id: ctx.slack_routing.team_id } : {}),
    };
    if (ctx.slack_user_id && SLACK_USER_RE.test(ctx.slack_user_id)) {
      return {
        kind: "slack_dm",
        slack_user_id: ctx.slack_user_id,
        ...(ctx.slack_routing.team_id ? { team_id: ctx.slack_routing.team_id } : {}),
        fallback: thread as Extract<ReminderDeliver, { kind: "slack_thread" }>,
      };
    }
    return thread;
  }
  if (ctx.chat_routing) {
    const r = ctx.chat_routing;
    if (r.kind === "whatsapp" && r.wa_id && r.phone_number_id) {
      return { kind: "whatsapp", wa_id: r.wa_id, phone_number_id: r.phone_number_id };
    }
    if (r.kind === "imessage" && r.line && r.handle) {
      return { kind: "imessage", line: r.line, handle: r.handle };
    }
    if (r.kind === "telegram" && r.chat_id) {
      return { kind: "telegram", chat_id: r.chat_id };
    }
    if (r.kind === "discord" && r.channel_id && r.guild_id) {
      return { kind: "discord", channel_id: r.channel_id, guild_id: r.guild_id };
    }
  }
  if (ctx.chat_thread_id) {
    return { kind: "chat_thread", thread_id: ctx.chat_thread_id };
  }
  return null;
}

export function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  const atSeconds = Math.floor(at.getTime() / 1000) * 1000;
  return (asUtc - atSeconds) / 60_000;
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localWallToUtc(localTime: string, tz: string): Date | null {
  const m = localTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (Number.isNaN(naive)) return null;
  let utc = naive - tzOffsetMinutes(tz, new Date(naive)) * 60_000;
  utc = naive - tzOffsetMinutes(tz, new Date(utc)) * 60_000;
  const out = new Date(utc);
  return Number.isNaN(out.getTime()) ? null : out;
}

export function formatLocal(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

export const reminderWhenSchema = z.union([
  z.object({
    kind: z.literal("in"),
    seconds: z.number().int().min(REMINDER_MIN_SECONDS).max(REMINDER_MAX_SECONDS),
  }),
  z.object({
    kind: z.literal("at"),
    local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  }),
  z.object({
    kind: z.literal("recurring"),
    cron: z.string().min(1),
  }),
]);

export type ReminderWhen = z.infer<typeof reminderWhenSchema>;

export type ResolvedWhen =
  | { schedule_kind: "once"; due_at: Date; cron_expression: null }
  | { schedule_kind: "recurring"; due_at: Date; cron_expression: string };

export function localCronToUtc(
  cron: string,
  tz: string,
  now: Date = new Date(),
): { cron: string; error: string | null } {
  const err = validateCronExpression(cron);
  if (err) return { cron, error: err };

  const toks = cron.trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = toks;

  if (!/^\d+$/.test(hour)) return { cron, error: null };

  const offsetMin = tzOffsetMinutes(tz, now);
  if (offsetMin === 0) return { cron, error: null };

  const minuteNum = /^\d+$/.test(min) ? Number(min) : 0;
  const totalLocal = Number(hour) * 60 + minuteNum;
  const totalUtc = totalLocal - offsetMin;

  const dayShift = Math.floor(totalUtc / 1440);
  const normalized = ((totalUtc % 1440) + 1440) % 1440;
  const utcHour = Math.floor(normalized / 60);
  const utcMin = normalized % 60;

  const newMin = /^\d+$/.test(min) ? String(utcMin) : min;
  const newHour = String(utcHour);

  let newDow = dow;
  if (dayShift !== 0 && dow !== "*") {
    const shifted = dow
      .split(",")
      .map((part) => {
        const range = part.split("-").map((n) => n.trim());
        const roll = (v: number) => String((((v + dayShift) % 7) + 7) % 7);
        if (range.length === 2 && /^\d+$/.test(range[0]) && /^\d+$/.test(range[1])) {
          return `${roll(Number(range[0]))}-${roll(Number(range[1]))}`;
        }
        return /^\d+$/.test(part.trim()) ? roll(Number(part.trim())) : part;
      })
      .join(",");
    newDow = shifted;
  }

  return { cron: normalizeCronExpression([newMin, newHour, dom, mon, newDow].join(" ")), error: null };
}

export function normalizeCronExpression(cron: string): string {
  return cron
    .trim()
    .split(/\s+/)
    .map((tok) => (/^\d+\.\d+$/.test(tok) ? String(Math.trunc(Number(tok))) : tok))
    .join(" ");
}

export function resolveWhen(
  when: ReminderWhen,
  tz: string,
  now: Date = new Date(),
): { ok: true; resolved: ResolvedWhen } | { ok: false; error: string } {
  if (when.kind === "in") {
    return {
      ok: true,
      resolved: {
        schedule_kind: "once",
        due_at: new Date(now.getTime() + when.seconds * 1000),
        cron_expression: null,
      },
    };
  }

  if (when.kind === "at") {
    const due = localWallToUtc(when.local_time, tz);
    if (!due) return { ok: false, error: `could not read the time "${when.local_time}"` };
    if (due.getTime() <= now.getTime()) {
      return {
        ok: false,
        error: `${formatLocal(due, tz)} is in the past — say a future time.`,
      };
    }
    return {
      ok: true,
      resolved: { schedule_kind: "once", due_at: due, cron_expression: null },
    };
  }

  const { cron, error } = localCronToUtc(when.cron, tz, now);
  if (error) return { ok: false, error };
  const next = nextCronFire(cron, now);
  if (!next) return { ok: false, error: "that schedule never fires" };
  return {
    ok: true,
    resolved: { schedule_kind: "recurring", due_at: next, cron_expression: cron },
  };
}

export function nextCronFire(cronUtc: string, after: Date): Date | null {
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const t = new Date(start + i * 60_000);
    if (cronMatches(cronUtc, t)) return t;
  }
  return null;
}

const BODY_MAX = 32000;

export function composePingBody(note: string): string {
  const body = `⏰ Reminder: ${note}`;
  return body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body;
}

export type ReminderDeliveryDeps = {
  postToThread: (args: {
    thread_id: string;
    tenant_id: string;
    body: string;
  }) => Promise<string | null>;
  postToSlack: (args: {
    tenant_id: string;
    channel_id: string;
    thread_ts?: string;
    team_id?: string;
    text: string;
  }) => Promise<string | null>;
  scrub: (text: string) => string;
  postToSlackDm?: (args: {
    tenant_id: string;
    slack_user_id: string;
    team_id?: string;
    text: string;
  }) => Promise<string | null>;
  postToWhatsApp?: (args: {
    tenant_id: string;
    wa_id: string;
    phone_number_id: string;
    text: string;
  }) => Promise<string | null>;
  postToIMessage?: (args: {
    tenant_id: string;
    line: string;
    handle: string;
    text: string;
  }) => Promise<string | null>;
  postToTelegram?: (args: {
    tenant_id: string;
    chat_id: number | string;
    text: string;
  }) => Promise<string | null>;
  postToDiscord?: (args: {
    tenant_id: string;
    channel_id: string;
    guild_id: string;
    text: string;
  }) => Promise<string | null>;
};

export async function deliverReminderPing(
  args: { tenant_id: string; note: string; deliver: unknown },
  deps: ReminderDeliveryDeps,
): Promise<string | null> {
  return deliverReminderBody(args.tenant_id, composePingBody(args.note), args.deliver, deps);
}

export const reminderRunPayloadSchema = z.object({
  prompt: z.string().min(1),
  deliver: reminderDeliverSchema,
});

export function composeRunBody(args: {
  prompt: string;
  status: "success" | "error" | "failed" | "cancelled";
  output_text: string | null;
  safe_error: string | null;
}): string {
  const header = `⏰ Reminder: ${args.prompt}`;
  let body: string;
  if (args.status === "success" && args.output_text && args.output_text.length > 0) {
    body = `${header}\n\n${args.output_text}`;
  } else if (args.status === "success") {
    body = `${header}\n\n(I ran this but it produced no text.)`;
  } else {
    body = `${header}\n\nI couldn't finish this one.\n\n${
      args.safe_error ?? `The run ended with status: ${args.status}`
    }`;
  }
  return body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body;
}

export async function deliverReminderRun(
  args: {
    tenant_id: string;
    status: "success" | "error" | "failed" | "cancelled";
    output_text: string | null;
    safe_error: string | null;
    payload: unknown;
  },
  deps: ReminderDeliveryDeps,
): Promise<string | null> {
  const rem =
    args.payload && typeof args.payload === "object"
      ? (args.payload as { reminder?: unknown }).reminder
      : undefined;
  const parsed = reminderRunPayloadSchema.safeParse(rem);
  if (!parsed.success) {
    return `reminder payload malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
  }
  const body = composeRunBody({
    prompt: parsed.data.prompt,
    status: args.status,
    output_text: args.output_text,
    safe_error: args.safe_error,
  });
  return deliverReminderBody(args.tenant_id, body, parsed.data.deliver, deps);
}

async function deliverReminderBody(
  tenant_id: string,
  rawBody: string,
  deliver: unknown,
  deps: ReminderDeliveryDeps,
): Promise<string | null> {
  const parsed = reminderDeliverSchema.safeParse(deliver);
  if (!parsed.success) {
    return `reminder deliver target malformed: ${parsed.error.issues
      .map((i) => i.message)
      .join("; ")}`;
  }
  const body = deps.scrub(rawBody);
  const target = parsed.data;

  if (target.kind === "chat_thread") {
    return deps.postToThread({ thread_id: target.thread_id, tenant_id, body });
  }

  if (target.kind === "slack_dm") {
    if (!deps.postToSlackDm) return "no slack DM sender wired";
    const err = await deps.postToSlackDm({
      tenant_id,
      slack_user_id: target.slack_user_id,
      ...(target.team_id ? { team_id: target.team_id } : {}),
      text: body.slice(0, 39000),
    });
    if (!err) return null;
    if (!target.fallback) return err;
    const fbErr = await deps.postToSlack({
      tenant_id,
      channel_id: target.fallback.channel_id,
      ...(target.fallback.kind === "slack_thread"
        ? { thread_ts: target.fallback.thread_ts }
        : {}),
      ...(target.fallback.team_id ? { team_id: target.fallback.team_id } : {}),
      text: body.slice(0, 39000),
    });
    return fbErr ? `dm failed (${err}); thread fallback failed (${fbErr})` : null;
  }

  if (target.kind === "whatsapp") {
    if (!deps.postToWhatsApp) return "no whatsapp sender wired";
    return deps.postToWhatsApp({
      tenant_id,
      wa_id: target.wa_id,
      phone_number_id: target.phone_number_id,
      text: body,
    });
  }

  if (target.kind === "imessage") {
    if (!deps.postToIMessage) return "no imessage sender wired";
    return deps.postToIMessage({ tenant_id, line: target.line, handle: target.handle, text: body });
  }

  if (target.kind === "telegram") {
    if (!deps.postToTelegram) return "no telegram sender wired";
    return deps.postToTelegram({ tenant_id, chat_id: target.chat_id, text: body });
  }

  if (target.kind === "discord") {
    if (!deps.postToDiscord) return "no discord sender wired";
    return deps.postToDiscord({
      tenant_id,
      channel_id: target.channel_id,
      guild_id: target.guild_id,
      text: body,
    });
  }

  return deps.postToSlack({
    tenant_id,
    channel_id: target.channel_id,
    ...(target.kind === "slack_thread" ? { thread_ts: target.thread_ts } : {}),
    ...(target.team_id ? { team_id: target.team_id } : {}),
    text: body.slice(0, 39000),
  });
}
