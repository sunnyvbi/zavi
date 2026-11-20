
import type { CatalogBreakdown, CatalogUnit } from "@/services/analytics/metric-registry";
import { unusualWords } from "@/services/analytics/anomaly";
import { DIMENSION_WORDS, type Confidence } from "@/services/analytics/explain-change";
import type { LocalDate } from "@/services/analytics/metric-time";
import { renderEmail } from "@/email/theme";

export type SymptomKind = "anomaly" | "zero" | "read_failed";

export type IncidentAlert = {
  tenant_id: string;
  incident_id: string;
  notice_seq: number;
  companyName: string;
  kind: "opened" | "worsened";
  primary: {
    kind: SymptomKind;
    label: string;
    unit: CatalogUnit;
    currency: string | null;
    date: LocalDate;
    direction: "up" | "down";
    value: number | null;
    typical: number | null;
    severity: number;
  };
  supporting: Array<{ label: string; unit: CatalogUnit; currency: string | null; direction: "up" | "down"; value: number | null; typical: number | null }>;
  contributors: Array<{ dimension: CatalogBreakdown; segment: string; share_pct: number; confidence: Confidence }>;
  woke: boolean;
  workspaceUrl: string;
  muteUrl: string;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayParts(d: LocalDate): { weekday: string; label: string } {
  const t = new Date(`${d}T12:00:00Z`);
  const weekday = WEEKDAYS[t.getUTCDay()];
  return { weekday, label: `${weekday.slice(0, 3)}, ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}` };
}

export function formatValue(v: number, unit: CatalogUnit, currency: string | null): string {
  if (unit === "currency") {
    const digits = Math.abs(v) >= 100 ? 0 : 2;
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
      } catch {
      }
    }
    return `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${currency ? ` ${currency}` : ""}`;
  }
  if (unit === "ratio") return `${(v * 100).toFixed(1)}%`;
  if (unit === "count") return Math.round(v).toLocaleString("en-US");
  return v.toFixed(1);
}

function shareText(pct: number): string {
  return pct > 100 ? "more than all" : `${Math.round(pct)}%`;
}

type Lines = { headline: string; body: string; supporting: string[]; contributors: string[]; follow: string | null };

function lines(a: IncidentAlert, seg: (s: string) => string): Lines {
  const p = a.primary;
  const { weekday, label } = dayParts(p.date);
  const lead = a.kind === "worsened" ? "Getting worse" : "Problem";
  const fmt = (v: number | null, x: { unit: CatalogUnit; currency: string | null }) => (v === null ? "?" : formatValue(v, x.unit, x.currency));
  let headline: string;
  let body: string;
  if (p.kind === "read_failed") {
    headline = `${lead}: Zavi could not read ${p.label} on ${label}`;
    body = "The connection returned an error, so numbers from it may be missing until it is fixed. Check the connection in Settings.";
  } else if (p.kind === "zero") {
    headline = `${lead}: ${p.label} dropped to zero on ${label}`;
    body = `It was above zero on every ${weekday} in the last 8 weeks, which usually means tracking broke rather than demand. Check the connection.`;
  } else {
    headline = `${lead}: ${p.label} ${p.direction === "down" ? "fell" : "rose"} to ${fmt(p.value, p)} on ${label}`;
    body = `A normal ${weekday} is about ${fmt(p.typical, p)}, so this is ${unusualWords(p.severity)} for the last 8 weeks.`;
  }
  return {
    headline,
    body,
    supporting: a.supporting.map(
      (s) => `${s.label} ${s.direction === "down" ? "fell" : "rose"} to ${fmt(s.value, s)} (normal about ${fmt(s.typical, s)})`,
    ),
    contributors: a.contributors.map(
      (d) => `${seg(d.segment)} (${DIMENSION_WORDS[d.dimension]}): ${shareText(d.share_pct)} of the change, ${d.confidence} confidence`,
    ),
    follow: a.woke ? "Your head of growth is looking into it and will follow up." : null,
  };
}

const CONTRIBUTORS_TITLE = "Possible contributors (moved with it, not proven causes)";

function cut(s: string, max = 80): string {
  const t = s.trim() || "(not set)";
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function escapeSlack(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackSegment(s: string): string {
  return escapeSlack(cut(s)).replace(/[*_~`]/g, (c) => `​${c}`);
}

export function renderIncidentSlack(a: IncidentAlert): string {
  const l = lines(a, slackSegment);
  const out = [`*${escapeSlack(a.companyName.trim() || "Your company")}: ${escapeSlack(l.headline)}*`, escapeSlack(l.body)];
  if (l.supporting.length) out.push("", "*Also moving*", l.supporting.map((s) => `• ${escapeSlack(s)}`).join("\n"));
  if (l.contributors.length) out.push("", `*${CONTRIBUTORS_TITLE}*`, l.contributors.map((d) => `• ${d}`).join("\n"));
  if (l.follow) out.push("", l.follow);
  out.push("", `<${a.workspaceUrl}|Open your workspace> · <${a.muteUrl}|Mute alerts for this metric>`);
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderIncidentEmail(a: IncidentAlert): { subject: string; text: string; html: string } {
  const company = a.companyName.trim() || "Your company";
  const l = lines(a, cut);
  const subject = `${company}: ${l.headline}`;
  const text = [
    l.headline,
    "",
    l.body,
    ...(l.supporting.length ? ["", "Also moving:", ...l.supporting.map((s) => `- ${s}`)] : []),
    ...(l.contributors.length ? ["", `${CONTRIBUTORS_TITLE}:`, ...l.contributors.map((d) => `- ${d}`)] : []),
    ...(l.follow ? ["", l.follow] : []),
    "",
    `Open your workspace: ${a.workspaceUrl}`,
    `Mute alerts for this metric: ${a.muteUrl}`,
  ].join("\n");
  const body = [
    ...(l.supporting.length ? [`<p><strong>Also moving</strong></p>`, `<ul>${l.supporting.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`] : []),
    ...(l.contributors.length
      ? [`<p><strong>${escapeHtml(CONTRIBUTORS_TITLE)}</strong></p>`, `<ul>${l.contributors.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`]
      : []),
    ...(l.follow ? [`<p>${escapeHtml(l.follow)}</p>`] : []),
  ].join("\n");
  const html = renderEmail({
    preheader: l.body,
    kicker: "Your numbers",
    eyebrow: escapeHtml(company),
    title: escapeHtml(l.headline),
    intro: escapeHtml(l.body),
    body,
    ctaText: "Open your workspace",
    ctaUrl: escapeHtml(a.workspaceUrl),
    footerNote: `You get this email because metric alerts are on for ${escapeHtml(company)}. <a href="${escapeHtml(a.muteUrl)}" style="color:inherit;">Mute alerts for this metric</a>`,
    footerVariant: "founder-growth",
  });
  return { subject, text, html };
}

export type AlertChannel = "slack" | "email" | "none";

export type AlertSendDeps = {
  slackDmChannel: (tenant_id: string) => Promise<{ channel: string; team_id: string | null; user: string } | null>;
  enqueueSlack: (args: { tenant_id: string; channel: string; team_id: string | null; body: string; key: string }) => Promise<boolean>;
  ownerEmail: (tenant_id: string) => Promise<string | null>;
  sendEmail: (args: { tenant_id: string; to: string; subject: string; text: string; html: string }) => Promise<void>;
};

export async function sendIncidentAlert(a: IncidentAlert, deps: AlertSendDeps = realAlertDeps): Promise<AlertChannel> {
  let dm: Awaited<ReturnType<AlertSendDeps["slackDmChannel"]>> = null;
  try {
    dm = await deps.slackDmChannel(a.tenant_id);
  } catch (e) {
    console.warn(`[anomaly-alert] Slack DM lookup failed for ${a.tenant_id}, using email: ${(e as Error).message}`);
  }
  if (dm) {
    const ok = await deps
      .enqueueSlack({
        tenant_id: a.tenant_id,
        channel: dm.channel,
        team_id: dm.team_id,
        body: renderIncidentSlack(a),
        key: `metric_incident:${a.incident_id}:${a.notice_seq}`,
      })
      .catch((e) => {
        console.warn(`[anomaly-alert] Slack enqueue failed for ${a.tenant_id}, using email: ${(e as Error).message}`);
        return false;
      });
    if (ok) return "slack";
  }
  const to = await deps.ownerEmail(a.tenant_id);
  if (!to) return "none";
  const r = renderIncidentEmail(a);
  await deps.sendEmail({ tenant_id: a.tenant_id, to, ...r });
  return "email";
}

const PERMANENT_DM_ERRORS = new Set([
  "users_not_found",
  "user_not_found",
  "account_inactive",
  "user_disabled",
  "cannot_dm_bot",
  "user_not_visible",
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "team_access_not_granted",
]);

export const realAlertDeps: AlertSendDeps = {
  async slackDmChannel(tenant_id) {
    const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
    const email = await resolveTenantOwnerEmail(tenant_id);
    if (!email) return null;
    const { resolveTargetSlackWorkspace } = await import("@/services/slack/resolve-target-workspace");
    const ws = await resolveTargetSlackWorkspace(tenant_id, "cgo");
    if (!ws) return null;
    const { slackFetch } = await import("@/services/tools/slack/_client");
    const { ExpectedToolError } = await import("@/services/tools/types");
    try {
      const who = await slackFetch<{ user?: { id?: string } }>(tenant_id, "users.lookupByEmail", { email }, ws.team_id);
      const user = who.user?.id;
      if (!user) return null;
      const open = await slackFetch<{ channel?: { id?: string } }>(tenant_id, "conversations.open", { users: user }, ws.team_id);
      const channel = open.channel?.id;
      return channel ? { channel, team_id: ws.team_id ?? null, user } : null;
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "slack_not_connected") return null;
      const slackError = e instanceof ExpectedToolError ? String(e.meta?.slack_error ?? "") : "";
      if (e instanceof ExpectedToolError && e.code === "slack_api_error" && PERMANENT_DM_ERRORS.has(slackError)) return null;
      throw e;
    }
  },
  async enqueueSlack({ tenant_id, channel, team_id, body, key }) {
    const { enqueueSlackOutbox } = await import("@/services/slack/outbox");
    const seq = await enqueueSlackOutbox({
      tenant_id,
      channel_id: channel,
      kind: "metric_anomaly",
      body,
      run_id: null,
      team_id,
      idempotency_key: key,
    });
    return seq != null;
  },
  async ownerEmail(tenant_id) {
    const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
    return resolveTenantOwnerEmail(tenant_id);
  },
  async sendEmail({ tenant_id, to, subject, text, html }) {
    if (!process.env.SYSTEM_SENDGRID_API_KEY) throw new Error("SYSTEM_SENDGRID_API_KEY unset");
    const { sendAgentOwnedEmail } = await import("@/email/sendAgentOwnedEmail");
    const { systemSender } = await import("@/email/system-identity");
    await sendAgentOwnedEmail({ tenant_id, agent_slug: "cgo", to, subject, html, text, fallbackFrom: systemSender() });
  },
};
