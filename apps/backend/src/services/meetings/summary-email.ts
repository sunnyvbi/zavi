
import { serviceClient } from "@/services/supabase";
import { meetUrl, workspaceUrl } from "@/services/web-base";
import { renderEmail } from "@/email/theme";
import { sgSend } from "@/email/sendAuthEmail";
import type { MeetingAtom } from "./distill";
import { minutesEmpty, type MeetingMinutes } from "./minutes";

const TYPE_LABELS: Record<string, string> = {
  blocker: "Blockers",
  commitment: "Commitments",
  decision: "Decisions",
  spec_fact: "Product facts",
  policy: "Policies",
  capacity_signal: "Capacity",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function approvalCta(canonical_count: number, approvals_url: string): {
  htmlNote: string;
  ctaText: string;
  textNote: string;
} {
  if (canonical_count > 0) {
    return {
      htmlNote: `<p style="margin:18px 0 0;color:#6b6b6b">${canonical_count} durable fact(s) were saved to the company brain.</p>`,
      ctaText: "Open Zavi",
      textNote: `\n\n${canonical_count} durable fact(s) were saved to the company brain. Open Zavi: ${approvals_url}`,
    };
  }
  return { htmlNote: "", ctaText: "Open Zavi", textNote: `\n\nOpen Zavi: ${approvals_url}` };
}

function renderMinutes(args: {
  meeting_date: string;
  minutes: MeetingMinutes;
  canonical_count: number;
  approvals_url: string;
}): { subject: string; html: string; text: string } {
  const m = args.minutes;
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (m.tldr.trim()) {
    htmlParts.push(
      `<p style="margin:0 0 6px;font-weight:600">TL;DR</p><p style="margin:0 0 4px">${esc(m.tldr)}</p>`,
    );
    textParts.push(`TL;DR\n${m.tldr}`);
  }

  const strList = (label: string, items: string[]) => {
    if (items.length === 0) return;
    htmlParts.push(
      `<p style="margin:18px 0 6px;font-weight:600">${label}</p><ul style="margin:0;padding-left:18px">${items
        .map((i) => `<li style="margin:0 0 6px">${esc(i)}</li>`)
        .join("")}</ul>`,
    );
    textParts.push(`${label}:\n${items.map((i) => `  • ${i}`).join("\n")}`);
  };

  strList("Decisions", m.decisions);

  if (m.action_items.length > 0) {
    const items = m.action_items.map((a) => {
      const owner = a.owner ? ` (${a.owner})` : "";
      const due = a.due_date ? ` (due ${a.due_date})` : "";
      return { text: a.text, owner, due };
    });
    htmlParts.push(
      `<p style="margin:18px 0 6px;font-weight:600">Action items</p><ul style="margin:0;padding-left:18px">${items
        .map(
          (i) =>
            `<li style="margin:0 0 6px">${esc(i.text)}${i.owner ? `<span style="color:#6b6b6b">${esc(i.owner)}</span>` : ""}${i.due ? `<span style="color:#6b6b6b">${esc(i.due)}</span>` : ""}</li>`,
        )
        .join("")}</ul>`,
    );
    textParts.push(
      `Action items:\n${items.map((i) => `  • ${i.text}${i.owner}${i.due}`).join("\n")}`,
    );
  }

  strList("Topics", m.topics);
  strList("Open questions", m.open_questions);

  const cta = approvalCta(args.canonical_count, args.approvals_url);
  const nDec = m.decisions.length;
  const nAct = m.action_items.length;
  const subject =
    nDec + nAct > 0
      ? `Meeting notes ${args.meeting_date}: ${nDec} decision(s), ${nAct} action(s)`
      : `Meeting notes for ${args.meeting_date}`;

  const html = renderEmail({
    title: `Standup notes for ${args.meeting_date}`,
    eyebrow: "Zavi Notetaker",
    body: htmlParts.join("") + cta.htmlNote,
    ctaText: cta.ctaText,
    ctaUrl: args.approvals_url,
    footerNote:
      "Zavi joined this meeting, transcribed it and wrote these notes. The recording is deleted once the transcript is saved in Zavi.",
    preheader: subject,
    footerVariant: "neutral",
  });

  const text = `Meeting notes ${args.meeting_date}\n\n${textParts.join("\n\n")}${cta.textNote}`;

  return { subject, html, text };
}

export function renderMeetingSummary(args: {
  meeting_date: string;
  atoms: MeetingAtom[];
  canonical_count: number;
  approvals_url: string;
  minutes?: MeetingMinutes | null;
  distill_failed?: boolean;
  transcript_saved?: boolean;
  team_alerted?: boolean;
}): { subject: string; html: string; text: string } {
  if (args.distill_failed) {
    const saved = args.transcript_saved === true;
    const alerted = args.team_alerted === true;
    const subject = `Meeting captured, notes pending (${args.meeting_date})`;
    const captured = saved
      ? "Zavi joined this meeting and saved the full transcript in Zavi (kept for 30 days), but automated notes couldn't be generated this time."
      : "Zavi joined this meeting and transcribed it, but automated notes couldn't be generated this time.";
    const next = alerted
      ? `Our team has been alerted and will reprocess ${saved ? "it from the saved transcript" : "the meeting"}. Your notes will follow. No action needed from you.`
      : "";
    const html = renderEmail({
      title: `Meeting captured on ${args.meeting_date}`,
      eyebrow: "Zavi Notetaker",
      body: `<p>${esc(captured)}</p>${next ? `<p style="margin:14px 0 0">${esc(next)}</p>` : ""}`,
      ctaText: "Open workspace",
      ctaUrl: args.approvals_url,
      footerNote: alerted
        ? "Zavi joined this meeting and transcribed it. Automated notes are pending a reprocess."
        : "Zavi joined this meeting and transcribed it.",
      preheader: subject,
      footerVariant: "neutral",
    });
    const text = `Meeting captured (${args.meeting_date}). ${captured}${next ? ` ${next}` : ""}`;
    return { subject, html, text };
  }

  if (args.minutes && !minutesEmpty(args.minutes)) {
    return renderMinutes({
      meeting_date: args.meeting_date,
      minutes: args.minutes,
      canonical_count: args.canonical_count,
      approvals_url: args.approvals_url,
    });
  }

  const groups = new Map<string, MeetingAtom[]>();
  for (const a of args.atoms) {
    const list = groups.get(a.atom_type) ?? [];
    list.push(a);
    groups.set(a.atom_type, list);
  }

  const sections: string[] = [];
  const textLines: string[] = [];
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    const list = groups.get(type);
    if (!list || list.length === 0) continue;
    textLines.push(`\n${label}:`);
    const items = list
      .map((a) => {
        const owner = a.owner ? ` (${a.owner})` : "";
        const due = a.due_date ? ` (due ${a.due_date})` : "";
        textLines.push(`  • ${a.title}${owner}${due}`);
        return `<li style="margin:0 0 6px">${esc(a.title)}${owner ? `<span style="color:#6b6b6b"> (${esc(a.owner ?? "")})</span>` : ""}${due ? `<span style="color:#6b6b6b">${esc(due)}</span>` : ""}</li>`;
      })
      .join("");
    sections.push(
      `<p style="margin:18px 0 6px;font-weight:600">${label}</p><ul style="margin:0;padding-left:18px">${items}</ul>`,
    );
  }

  const empty = args.atoms.length === 0;
  const body = empty
    ? `<p>Zavi sat in on this meeting but didn't find blockers, commitments, or decisions worth saving. The recording is deleted once the transcript is saved in Zavi.</p>`
    : sections.join("") +
      (args.canonical_count > 0
        ? `<p style="margin:18px 0 0;color:#6b6b6b">${args.canonical_count} durable fact(s) were saved to the company brain.</p>`
        : "");

  const subject = empty
    ? `Zavi sat in: nothing notable (${args.meeting_date})`
    : `Meeting notes ${args.meeting_date}: ${args.atoms.length} item(s) captured`;

  const html = renderEmail({
    title: `Standup notes for ${args.meeting_date}`,
    eyebrow: "Zavi Notetaker",
    body,
    ctaText: "Open Zavi",
    ctaUrl: args.approvals_url,
    footerNote:
      "Zavi joined this meeting, transcribed it and saved the operating deltas. The recording is deleted once the transcript is saved in Zavi.",
    preheader: subject,
    footerVariant: "neutral",
  });

  const text = empty
    ? `Zavi sat in on this meeting but found nothing notable. The recording is deleted once the transcript is saved in Zavi.`
    : `Meeting notes ${args.meeting_date}${textLines.join("\n")}\n\n` +
      (args.canonical_count > 0
        ? `${args.canonical_count} durable fact(s) were saved to the company brain. Open Zavi: ${args.approvals_url}`
        : `Open Zavi: ${args.approvals_url}`);

  return { subject, html, text };
}

export async function resolveSummaryRecipients(
  tenant_id: string,
  requested_by: string | null,
): Promise<string[]> {
  const svc = serviceClient();
  const ids = new Set<string>();
  const { data: owner } = await svc
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (owner?.user_id) ids.add(owner.user_id as string);
  if (requested_by) ids.add(requested_by);

  const emails: string[] = [];
  for (const id of ids) {
    const { data } = await svc.auth.admin.getUserById(id);
    const email = data?.user?.email;
    if (email) emails.push(email);
  }
  return [...new Set(emails)];
}

export async function sendMeetingSummaryEmail(args: {
  tenant_id: string;
  requested_by: string | null;
  meeting_date: string;
  atoms: MeetingAtom[];
  canonical_count: number;
  minutes?: MeetingMinutes | null;
  distill_failed?: boolean;
  transcript_saved?: boolean;
  team_alerted?: boolean;
}): Promise<{ sent: number; reason?: string }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) return { sent: 0, reason: "no_system_key" };
  const recipients = await resolveSummaryRecipients(args.tenant_id, args.requested_by);
  if (recipients.length === 0) return { sent: 0, reason: "no_recipients" };

  const approvals_url = workspaceUrl();
  const rendered = renderMeetingSummary({
    meeting_date: args.meeting_date,
    atoms: args.atoms,
    canonical_count: args.canonical_count,
    minutes: args.minutes,
    approvals_url,
    distill_failed: args.distill_failed,
    transcript_saved: args.transcript_saved,
    team_alerted: args.team_alerted,
  });
  let sent = 0;
  for (const to of recipients) {
    await sgSend(to, rendered.subject, rendered.html, rendered.text);
    sent += 1;
  }
  return { sent };
}

async function ownerEmails(tenant_id: string): Promise<string[]> {
  return resolveSummaryRecipients(tenant_id, null);
}

export function renderChooseDestinationEmail(meet_url: string): { subject: string; html: string; text: string } {
  const subject = "Choose where Zavi shares your meeting notes";
  const lines = [
    "Zavi Notetaker captured a meeting for your team. Its notes are saved in Zavi.",
    "Choose where Zavi shares meeting summaries: a Slack channel, email, or nowhere (they stay in Zavi). Until you choose, Zavi doesn't post or email them.",
  ];
  const html = renderEmail({
    title: "Where should meeting notes go?",
    eyebrow: "Zavi Notetaker",
    body: lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join(""),
    ctaText: "Choose where they go",
    ctaUrl: meet_url,
    preheader: subject,
    footerVariant: "neutral",
  });
  return { subject, html, text: `${lines.join("\n\n")}\n\nChoose where they go: ${meet_url}` };
}

export function renderRecapPostFailedEmail(
  channel_name: string | null,
  meet_url: string,
): { subject: string; html: string; text: string } {
  const where = channel_name ? `#${channel_name}` : "your Slack channel";
  const subject = `Zavi couldn't post meeting notes to ${where}`;
  const lines = [
    `Zavi Notetaker couldn't post the notes from your last meeting to ${where}. They're saved in Zavi.`,
    `Make sure @Zavi is in ${where}, or choose another place for meeting notes.`,
  ];
  const html = renderEmail({
    title: `Couldn't post to ${where}`,
    eyebrow: "Zavi Notetaker",
    body: lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join(""),
    ctaText: "Open the notes",
    ctaUrl: meet_url,
    preheader: subject,
    footerVariant: "neutral",
  });
  return { subject, html, text: `${lines.join("\n\n")}\n\nOpen the notes: ${meet_url}` };
}

async function sendToOwner(
  tenant_id: string,
  rendered: { subject: string; html: string; text: string },
): Promise<{ sent: number; reason?: string }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) return { sent: 0, reason: "no_system_key" };
  const to = await ownerEmails(tenant_id);
  if (to.length === 0) return { sent: 0, reason: "no_recipients" };
  for (const addr of to) await sgSend(addr, rendered.subject, rendered.html, rendered.text);
  return { sent: to.length };
}

export async function sendChooseDestinationEmail(tenant_id: string): Promise<{ sent: number; reason?: string }> {
  return sendToOwner(tenant_id, renderChooseDestinationEmail(meetUrl(tenant_id)));
}

export async function sendRecapPostFailedEmail(
  tenant_id: string,
  channel_name: string | null,
): Promise<{ sent: number; reason?: string }> {
  return sendToOwner(tenant_id, renderRecapPostFailedEmail(channel_name, meetUrl(tenant_id)));
}

export async function sendDistillFailureOpsAlert(args: {
  tenant_id: string;
  meeting_bot_id: string;
  meeting_date: string;
  error: string;
  kind?: "distill_failed" | "transcript_not_saved";
  transcript_saved?: boolean;
}): Promise<{ sent: boolean; logged?: boolean }> {
  const distillFailed = args.kind !== "transcript_not_saved";
  const fallback = async (why: string) => {
    try {
      const { logEventConfirmed } = await import("@/services/logging/logEvent");
      const { ok } = await logEventConfirmed({
        level: "error",
        source: "notetaker",
        code: distillFailed ? "notetaker.distill_failed_unpaged" : "notetaker.transcript_not_saved_unpaged",
        tenant_id: args.tenant_id,
        message:
          `ops page not sent (${why}). meeting_bot_id=${args.meeting_bot_id} transcript_saved=${args.transcript_saved === true}. ` +
          `Run dist/scripts/notetaker-reprocess.js ${args.meeting_bot_id}`,
      });
      return { sent: false, logged: ok };
    } catch {
      return { sent: false, logged: false };
    }
  };
  try {
    if (!process.env.SYSTEM_SENDGRID_API_KEY) return await fallback("no mail key");
    const to = process.env.OPS_ALERT_EMAIL ?? "ravi@zaviagent.com";
    const saved = args.transcript_saved === true;
    const subject = distillFailed
      ? `[Zavi Notetaker] distill failed — ${args.meeting_date} (tenant ${args.tenant_id})`
      : `[Zavi Notetaker] transcript not saved, recording kept — ${args.meeting_date} (tenant ${args.tenant_id})`;
    const lines = [
      distillFailed
        ? `Notetaker distill failed for a captured meeting. Customer got the transcript-only fallback.`
        : `Notetaker could not save a meeting's transcript in Zavi. The summary went out as usual.`,
      ``,
      `tenant_id:       ${args.tenant_id}`,
      `meeting_bot_id:  ${args.meeting_bot_id}`,
      `meeting_date:    ${args.meeting_date}`,
      `error:           ${args.error}`,
      ``,
      saved
        ? `The transcript is saved in Zavi (meeting_notes, kept 30 days) and the Recall recording is being deleted (the reconcile cron retries a failed delete). Reprocess from the saved transcript once the cause is fixed, within 30 days:`
        : distillFailed
          ? `The transcript could NOT be saved in Zavi, so the Recall recording is KEPT. Reprocess once the cause is fixed (it reads Recall, saves the transcript, writes the notes, then deletes the recording):`
          : `The Recall recording is KEPT until the transcript is saved. Run this once the database is fine (it reads Recall, saves the transcript, then deletes the recording; it sends nothing):`,
      `  docker exec praxis-backend node --env-file=/app/apps/backend/.env /app/apps/backend/dist/scripts/notetaker-reprocess.js ${args.meeting_bot_id}`,
    ];
    const text = lines.join("\n");
    const html = `<pre style="font:13px ui-monospace,monospace;white-space:pre-wrap">${esc(text)}</pre>`;
    await sgSend(to, subject, html, text);
    return { sent: true };
  } catch (e) {
    return await fallback(`send failed: ${(e as Error)?.message ?? "unknown"}`.slice(0, 200));
  }
}
