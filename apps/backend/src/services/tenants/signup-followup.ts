
import { DOGFOOD_SLUGS, alertRecipient } from "./new-tenant-alert";
import { FOUNDER_ALERT_EVENTS, type FounderAlertEvent } from "./founder-activity-alert";

export const SIGNUP_FOLLOWUP_EVENT = "tenant/signup.followup";
export const SIGNUP_FOLLOWUP_DELAY = "24h";

const USER_TRIGGERS = [
  "chat", "channel_recipe", "manual", "playbook",
  "slack", "email", "whatsapp", "imessage", "telegram", "teams", "discord",
];

const FAILED_STATUSES = new Set(["failed", "parse_failed", "dispatch_error"]);

export async function armSignupFollowup(tenant_id: string, user_id: string): Promise<void> {
  const { inngest } = await import("../../../workers/client");
  await inngest.send({
    id: `signup-followup-${tenant_id}`,
    name: SIGNUP_FOLLOWUP_EVENT,
    data: { tenant_id, user_id },
  });
}

export type SignupActivity = {
  tenant_id: string;
  name: string;
  owner_email: string | null;
  created_at: string | null;
  chats: number;
  runs: Array<{ agent: string; total: number; failed: number }>;
  credits_spent: number;
  connectors: string[];
  milestones: string[];
  last_seen: string | null;
};

export interface SignupFollowupDeps {
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: () => any;
  alertsEnabled: () => Promise<boolean>;
}

async function defaultDeps(): Promise<SignupFollowupDeps> {
  const [{ serviceClient }, { sgSend }, settings] = await Promise.all([
    import("../supabase"),
    import("../../email/sendAuthEmail"),
    import("../settings"),
  ]);
  return {
    serviceClient,
    sgSend,
    alertsEnabled: async () =>
      (await settings.getBoolSetting("signup_alert_emails_enabled")) &&
      (await settings.getBoolSetting("founder_activity_alerts_enabled")),
  };
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`signup-followup: ${what} read failed: ${res.error.message}`);
  return res.data;
}

function later(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export type SignupTenant = {
  id: string;
  slug: string;
  display_name: string | null;
  created_at: string | null;
  kind: string | null;
  deleted_at: string | null;
};

export function skipSignupTenant(tenant: SignupTenant | null): boolean {
  return !tenant || !!tenant.deleted_at || tenant.kind === "test" || DOGFOOD_SLUGS.has(tenant.slug);
}

export async function loadSignupActivity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  tenant: SignupTenant,
  user_id: string | null,
): Promise<SignupActivity | null> {
  if (skipSignupTenant(tenant)) return null;
  const tenant_id = tenant.id;

  const messages = (must(
    await sb
      .from("agent_thread_messages")
      .select("created_at")
      .eq("tenant_id", tenant_id)
      .eq("sender_role", "user")
      .order("created_at", { ascending: false })
      .limit(1000),
    "messages",
  ) ?? []) as Array<{ created_at: string }>;

  const runRows = (must(
    await sb
      .from("agent_runs")
      .select("agent_slug, status, actor_user_id, enqueued_at")
      .eq("tenant_id", tenant_id)
      .in("trigger", USER_TRIGGERS)
      .order("enqueued_at", { ascending: false })
      .limit(1000),
    "runs",
  ) ?? []) as Array<{ agent_slug: string; status: string | null; actor_user_id: string | null; enqueued_at: string | null }>;

  const settles = (must(
    await sb
      .from("tenant_credit_ledger")
      .select("amount, debited")
      .eq("tenant_id", tenant_id)
      .in("kind", ["settle", "media"])
      .limit(5000),
    "credits",
  ) ?? []) as Array<{ amount: number | string | null; debited: number | string | null }>;

  const connectorRows = (must(
    await sb.from("connector_metadata").select("slug").eq("tenant_id", tenant_id).limit(100),
    "connectors",
  ) ?? []) as Array<{ slug: string }>;

  const settingRows = (must(
    await sb
      .from("tenant_app_setting")
      .select("key, value")
      .eq("tenant_id", tenant_id)
      .in("key", ["founder_alerts_sent"]),
    "settings",
  ) ?? []) as Array<{ key: string; value: unknown }>;

  let owner_email: string | null = null;
  const actor = user_id ?? runRows.find((r) => r.actor_user_id)?.actor_user_id;
  if (actor) {
    try {
      const { data: u } = await sb.auth.admin.getUserById(actor);
      owner_email = u?.user?.email ?? null;
    } catch {
    }
  }

  const byAgent = new Map<string, { total: number; failed: number }>();
  for (const r of runRows) {
    const e = byAgent.get(r.agent_slug) ?? { total: 0, failed: 0 };
    e.total += 1;
    if (r.status && FAILED_STATUSES.has(r.status)) e.failed += 1;
    byAgent.set(r.agent_slug, e);
  }

  const sent = settingRows.find((r) => r.key === "founder_alerts_sent")?.value;
  const milestones =
    sent && typeof sent === "object"
      ? Object.keys(sent as Record<string, unknown>)
          .map((k) => k.split(":")[0] as FounderAlertEvent)
          .filter((k, i, all) => k in FOUNDER_ALERT_EVENTS && all.indexOf(k) === i)
          .map((k) => FOUNDER_ALERT_EVENTS[k].label)
      : [];

  return {
    tenant_id,
    name: tenant.display_name || tenant.slug,
    owner_email,
    created_at: tenant.created_at,
    chats: messages.length,
    runs: [...byAgent.entries()]
      .map(([agent, v]) => ({ agent, ...v }))
      .sort((a, b) => b.total - a.total),
    credits_spent: Math.round(
      settles.reduce((n, r) => n + Math.max(0, Number(r.debited ?? r.amount) || 0), 0),
    ),
    connectors: [...new Set(connectorRows.map((c) => c.slug))],
    milestones,
    last_seen: later(messages[0]?.created_at ?? null, runRows[0]?.enqueued_at),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ptTime(iso: string | null): string {
  if (!iso) return "never";
  return `${new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  })} PT`;
}

export function renderSignupFollowup(a: SignupActivity): { subject: string; html: string; text: string } {
  const totalRuns = a.runs.reduce((n, r) => n + r.total, 0);
  const idle = a.chats === 0 && totalRuns === 0 && a.connectors.length === 0 && a.milestones.length === 0;
  const summary = idle
    ? "no activity"
    : [
        plural(a.chats, "chat"),
        plural(totalRuns, "run"),
        a.connectors.length ? plural(a.connectors.length, "connector") : "no connectors",
      ].join(", ");
  const subject = `${a.name}, 24h later: ${summary}${a.owner_email ? ` (${a.owner_email})` : ""}`;

  const runsLine = a.runs.length
    ? a.runs
        .slice(0, 8)
        .map((r) => `${r.agent} ×${r.total}${r.failed ? ` (${r.failed} failed)` : ""}`)
        .join(", ")
    : "none";
  const rows: Array<[string, string]> = [
    ["Chat messages", String(a.chats)],
    ["Runs they started", totalRuns ? `${totalRuns}: ${runsLine}` : "none"],
    ["Credits spent", String(a.credits_spent)],
    ["Connectors", a.connectors.length ? a.connectors.join(", ") : "none"],
    ["Milestones", a.milestones.length ? a.milestones.join(", ") : "none"],
    ["Last seen", ptTime(a.last_seen)],
    ["Signed up", ptTime(a.created_at)],
  ];
  const headline = idle
    ? `${a.name} has done nothing since signing up 24 hours ago.`
    : `${a.name}, 24 hours after signing up.`;
  const console_ = `${(process.env.ADMIN_ORIGIN || "https://admin.zaviagent.com").replace(/\/$/, "")}/tenants/${a.tenant_id}`;

  const text = [
    headline,
    ``,
    rows.map(([k, v]) => `${k.padEnd(18)} ${v}`).join("\n"),
    ``,
    `Staff console: ${console_}`,
    ``,
    `One email per new tenant, a day after signup. Test and dogfood tenants are excluded.`,
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <p style="font-size:15px;margin:0 0 16px 0;${idle ? "color:#b45309;" : ""}"><strong>${escapeHtml(headline)}</strong></p>
      <table style="border-collapse:collapse;margin:0 0 24px 0;">${rows
        .map(
          ([k, v]) => `
        <tr>
          <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:4px 0;color:#111;font-size:13px;">${escapeHtml(v)}</td>
        </tr>`,
        )
        .join("")}</table>
      <p style="margin:0;font-size:13px;"><a href="${escapeHtml(console_)}" style="color:#111;">Staff console</a></p>
      <p style="margin:20px 0 0 0;color:#999;font-size:11px;">One email per new tenant, a day after signup. Test and dogfood tenants are excluded.</p>
    </div>`;

  return { subject, html, text };
}

export type SignupFollowupOutcome = { sent: true } | { sent: false; reason: string };

export async function sendSignupFollowup(
  tenant: SignupTenant,
  user_id: string | null,
  injected?: Partial<SignupFollowupDeps>,
): Promise<SignupFollowupOutcome> {
  const deps: SignupFollowupDeps = { ...(await defaultDeps()), ...injected };
  if (!(await deps.alertsEnabled())) return { sent: false, reason: "muted" };
  const activity = await loadSignupActivity(deps.serviceClient(), tenant, user_id);
  if (!activity) return { sent: false, reason: "skipped_tenant" };
  const { subject, html, text } = renderSignupFollowup(activity);
  await deps.sgSend(alertRecipient(), subject, html, text);
  return { sent: true };
}
