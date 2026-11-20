
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSlackApprover } from "@/services/slack/resolve-member";
import { webBaseUrl } from "@/services/web-base";
import { escapeEmailHtml, renderEmail } from "@/email/theme";
import { reminderDeliverSchema, type ReminderDeliver } from "./reminders";
import { scrubAgentEgress } from "./scrub-agent-egress";

const SUBJECT_NOTE_MAX = 60;

export const REMINDER_EMAIL_TIMEOUT_MS = 8_000;

export type ReminderEmailInput = {
  tenant_id: string;
  agent_slug: string;
  mode: "ping" | "run";
  note: string;
  created_by: string | null;
  slack_user_id?: string | null;
  deliver: unknown;
};

export type ReminderEmailDeps = {
  isMember: (tenant_id: string, user_id: string) => Promise<boolean>;
  slackLinkedUser: (args: { tenant_id: string; team_id: string; slack_user_id: string }) => Promise<string | null>;
  emailOf: (user_id: string) => Promise<string | null>;
  scrub: (text: string) => string;
  send: (msg: {
    tenant_id: string;
    agent_slug: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }) => Promise<void>;
  baseUrl: () => string;
};

export type ReminderEmailOutcome = { sent: true } | { sent: false; reason: string };

export function reminderEmailSubject(note: string): string {
  const one = note.replace(/\s+/g, " ").trim();
  const cut =
    one.length > SUBJECT_NOTE_MAX ? `${one.slice(0, SUBJECT_NOTE_MAX - 1).trimEnd()}…` : one;
  return `Reminder: ${cut}`;
}

function resultPlace(target: ReminderDeliver | null, base: string): { where: string; url: string | null } {
  if (!target) return { where: "where you set this reminder", url: null };
  const slackLink = (channel_id: string, team_id?: string) =>
    `https://slack.com/app_redirect?channel=${encodeURIComponent(channel_id)}${
      team_id ? `&team=${encodeURIComponent(team_id)}` : ""
    }`;
  switch (target.kind) {
    case "chat_thread":
      return { where: "your Zavi chat", url: `${base}/workspace/${encodeURIComponent(target.thread_id)}` };
    case "slack_thread":
    case "slack_channel":
      return { where: "Slack", url: slackLink(target.channel_id, target.team_id) };
    case "slack_dm":
      return { where: "your Slack DMs", url: null };
    case "whatsapp":
      return { where: "WhatsApp", url: null };
    case "imessage":
      return { where: "iMessage", url: null };
    case "telegram":
      return { where: "Telegram", url: null };
    case "discord":
      return { where: "Discord", url: null };
    default:
      return { where: "where you set this reminder", url: null };
  }
}

export function renderReminderEmail(args: {
  mode: "ping" | "run";
  note: string;
  deliver: unknown;
  baseUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = reminderEmailSubject(args.note);
  const parsed = reminderDeliverSchema.safeParse(args.deliver);
  const target = parsed.success ? parsed.data : null;
  const place = resultPlace(target, args.baseUrl);
  const zaviUrl = `${args.baseUrl}/workspace`;

  const noteHtml = escapeEmailHtml(args.note).replace(/\n/g, "<br>");
  let ctaText: string;
  let ctaUrl: string;
  let runLine: string | null = null;
  if (args.mode === "run") {
    runLine = `Zavi is working on it now. The result will be posted in ${place.where}.`;
    ctaText = place.url ? "See the result" : "Open Zavi";
    ctaUrl = place.url ?? zaviUrl;
  } else {
    ctaText = place.url && target?.kind === "chat_thread" ? "Open the chat" : "Open Zavi";
    ctaUrl = place.url && target?.kind === "chat_thread" ? place.url : zaviUrl;
  }

  const html = renderEmail({
    preheader: args.note.replace(/\s+/g, " ").slice(0, 120),
    kicker: "Reminder",
    title: "Your reminder",
    body: `<p>${noteHtml}</p>${runLine ? `<p>${escapeEmailHtml(runLine)}</p>` : ""}`,
    ctaText,
    ctaUrl,
    footerNote: "You're getting this because you asked Zavi to remind you.",
    footerVariant: "neutral",
  });

  const text = [
    "Your reminder",
    "",
    args.note,
    ...(runLine ? ["", runLine] : []),
    "",
    `${ctaText}: ${ctaUrl}`,
    "",
    "You're getting this because you asked Zavi to remind you.",
  ].join("\n");

  return { subject, html, text };
}

export function reminderSlackTeamId(deliver: unknown): string | null {
  const parsed = reminderDeliverSchema.safeParse(deliver);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (t.kind === "slack_dm" || t.kind === "slack_thread" || t.kind === "slack_channel") {
    return t.team_id?.trim() ? t.team_id : null;
  }
  return null;
}

export async function sendReminderEmail(
  input: ReminderEmailInput,
  deps: ReminderEmailDeps = defaultReminderEmailDeps(),
  opts: { timeoutMs?: number } = {},
): Promise<ReminderEmailOutcome> {
  const timeoutMs = opts.timeoutMs ?? REMINDER_EMAIL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReminderEmailOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, reason: "send_timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([sendReminderEmailUnbounded(input, deps), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendReminderEmailUnbounded(
  input: ReminderEmailInput,
  deps: ReminderEmailDeps,
): Promise<ReminderEmailOutcome> {
  try {
    let user_id = input.created_by;
    if (!user_id && input.slack_user_id) {
      const team_id = reminderSlackTeamId(input.deliver);
      if (!team_id) return { sent: false, reason: "no_slack_team" };
      const linked = await deps.slackLinkedUser({
        tenant_id: input.tenant_id,
        team_id,
        slack_user_id: input.slack_user_id,
      });
      if (!linked) return { sent: false, reason: "no_slack_link" };
      user_id = linked;
    }
    if (!user_id) return { sent: false, reason: "no_creator" };
    if (!(await deps.isMember(input.tenant_id, user_id))) {
      return { sent: false, reason: "creator_not_member" };
    }
    const to = await deps.emailOf(user_id);
    if (!to) return { sent: false, reason: "no_creator_email" };

    const rendered = renderReminderEmail({
      mode: input.mode,
      note: deps.scrub(input.note),
      deliver: input.deliver,
      baseUrl: deps.baseUrl(),
    });
    await deps.send({
      tenant_id: input.tenant_id,
      agent_slug: input.agent_slug,
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `send_failed: ${(e as Error).message}`.slice(0, 300) };
  }
}

export function defaultReminderEmailDeps(svc?: SupabaseClient): ReminderEmailDeps {
  return {
    slackLinkedUser: (args) => (svc ? resolveSlackApprover(svc, args) : Promise.resolve(null)),
    isMember: async (tenant_id, user_id) => {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("tenant_users")
        .select("user_id")
        .eq("user_id", user_id)
        .maybeSingle<{ user_id: string }>();
      return !error && !!data;
    },
    emailOf: async (user_id) => {
      const { resolveMemberEmail } = await import("@/email/sendAuthEmail");
      return resolveMemberEmail(user_id);
    },
    scrub: (text) => scrubAgentEgress(text, { surface: "persist" }).text,
    send: async (msg) => {
      const { sendAgentOwnedEmail } = await import("@/email/sendAgentOwnedEmail");
      const { resolveAgentSendingIdentity } = await import("@/email/sending-identity");
      const identity = await resolveAgentSendingIdentity(msg.tenant_id);
      await sendAgentOwnedEmail({ ...msg, fallbackFrom: { email: identity.from, name: identity.name } });
    },
    baseUrl: webBaseUrl,
  };
}
