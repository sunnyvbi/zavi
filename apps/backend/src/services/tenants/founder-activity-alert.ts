
import { DOGFOOD_SLUGS } from "./new-tenant-alert";

export type FounderAlertEvent =
  | "launch_video_requested"
  | "launch_video_claimed"
  | "first_chat_message"
  | "teammate_invited"
  | "first_channel_run"
  | "first_connector"
  | "first_approval"
  | "out_of_credits"
  | "plan_upgrade_required"
  | "feedback_submitted"
  | "website_published";

type Dedupe = "once" | "daily" | "none";

export const FOUNDER_ALERT_EVENTS: Record<FounderAlertEvent, { label: string; dedupe: Dedupe }> = {
  launch_video_requested: { label: "Launch video requested", dedupe: "none" },
  launch_video_claimed: { label: "Launch video claimed (account created)", dedupe: "once" },
  first_chat_message: { label: "First chat message", dedupe: "once" },
  teammate_invited: { label: "Invited a teammate", dedupe: "none" },
  first_channel_run: { label: "First channel run", dedupe: "once" },
  first_connector: { label: "First connector connected", dedupe: "once" },
  first_approval: { label: "First action approved", dedupe: "once" },
  out_of_credits: { label: "Ran out of credits", dedupe: "daily" },
  plan_upgrade_required: { label: "Hit a plan wall (needs a higher plan)", dedupe: "daily" },
  feedback_submitted: { label: "Feedback submitted", dedupe: "none" },
  website_published: { label: "Website published", dedupe: "once" },
};

const SENT_KEY = "founder_alerts_sent";
const ENABLED_KEY = "founder_activity_alerts_enabled";
const EVENTS_KEY = "founder_alert_events_emailed";
export const DEFAULT_EMAILED_EVENTS: readonly FounderAlertEvent[] = ["out_of_credits", "plan_upgrade_required", "feedback_submitted"];

export function paywallFounderEvent(reason: string): "out_of_credits" | "plan_upgrade_required" {
  return reason === "plan_upgrade_required" ? "plan_upgrade_required" : "out_of_credits";
}

export type AlertDetails = Record<string, string | number | boolean | null | undefined>;

export interface FounderAlertInput {
  event: FounderAlertEvent;
  tenant_id?: string | null;
  user_id?: string | null;
  email?: string | null;
  details?: AlertDetails;
}

export interface FounderAlertDeps {
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: () => any;
  getBoolSetting: (key: typeof ENABLED_KEY) => Promise<boolean>;
  emailedEvents: () => Promise<readonly string[]>;
  setTenantSetting: (tenant_id: string, key: typeof SENT_KEY, value: unknown, updated_by: string) => Promise<void>;
  now: () => Date;
}

export function founderAlertRecipients(): string[] {
  const raw = process.env.FOUNDER_ACTIVITY_ALERT_EMAILS || "ravi@zaviagent.com,tarun@zaviagent.com";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function adminBase(): string {
  return (process.env.ADMIN_ORIGIN || "https://admin.zaviagent.com").replace(/\/$/, "");
}

async function defaultDeps(): Promise<FounderAlertDeps> {
  const [{ serviceClient }, { sgSend }, settings] = await Promise.all([
    import("../supabase"),
    import("../../email/sendAuthEmail"),
    import("../settings"),
  ]);
  return {
    serviceClient,
    sgSend,
    getBoolSetting: (key) => settings.getBoolSetting(key),
    emailedEvents: async () => {
      const v = await settings.getSetting(EVENTS_KEY);
      return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : DEFAULT_EMAILED_EVENTS;
    },
    setTenantSetting: settings.setTenantSetting,
    now: () => new Date(),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function dedupeKey(event: FounderAlertEvent, now: Date): string | null {
  const mode = FOUNDER_ALERT_EVENTS[event].dedupe;
  if (mode === "none") return null;
  return mode === "daily" ? `${event}:${now.toISOString().slice(0, 10)}` : event;
}

export type RenderInput = {
  event: FounderAlertEvent;
  company: string | null;
  email: string | null;
  tenant_id: string | null;
  details: AlertDetails;
  at: string;
};

export function renderFounderAlert(r: RenderInput): { subject: string; html: string; text: string } {
  const label = FOUNDER_ALERT_EVENTS[r.event].label;
  const who = r.company || r.email || "someone";
  const subject = `Zavi: ${label} by ${who}${r.email && r.company ? ` (${r.email})` : ""}`;

  const facts: Array<[string, string]> = [
    ["Action", label],
    ["Company", r.company ?? "(none)"],
    ["Email", r.email ?? "(unknown)"],
  ];
  for (const [k, v] of Object.entries(r.details)) {
    if (v === null || v === undefined || v === "") continue;
    facts.push([k.replace(/_/g, " "), String(v).slice(0, 600)]);
  }
  facts.push(["When", r.at]);

  const consoleUrl = r.tenant_id ? `${adminBase()}/tenants/${r.tenant_id}` : null;
  const text = [
    `${who}: ${label}.`,
    ``,
    ...facts.map(([k, v]) => `${k.padEnd(14)} ${v}`),
    ...(consoleUrl ? [``, `Staff console: ${consoleUrl}`] : []),
    ``,
    `Test and dogfood tenants are excluded. Mute all of these with the founder_activity_alerts_enabled setting.`,
  ].join("\n");

  const rows = facts
    .map(
      ([k, v]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:4px 0;color:#111;font-size:13px;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <p style="font-size:15px;margin:0 0 16px 0;"><strong>${escapeHtml(who)}</strong>: ${escapeHtml(label)}.</p>
      <table style="border-collapse:collapse;margin:0 0 16px 0;">${rows}</table>
      ${consoleUrl ? `<p style="margin:0;font-size:13px;"><a href="${escapeHtml(consoleUrl)}" style="color:#111;">Staff console</a></p>` : ""}
      <p style="margin:20px 0 0 0;color:#999;font-size:11px;">Test and dogfood tenants are excluded. Mute all of these with the founder_activity_alerts_enabled setting.</p>
    </div>`;
  return { subject, html, text };
}

const settled = new Set<string>();

export function __resetFounderAlertMemo(): void {
  settled.clear();
}

export type FounderAlertOutcome = { sent: true } | { sent: false; reason: string };

export async function notifyFounderActivity(
  input: FounderAlertInput,
  injected?: Partial<FounderAlertDeps>,
): Promise<FounderAlertOutcome> {
  if (process.env.VITEST && !injected) return { sent: false, reason: "test_env" };
  try {
    const deps: FounderAlertDeps = { ...(await defaultDeps()), ...injected };
    const now = deps.now();
    const key = dedupeKey(input.event, now);
    const memoKey = input.tenant_id && key ? `${input.tenant_id}:${key}` : null;
    if (memoKey && settled.has(memoKey)) return { sent: false, reason: "already_sent" };
    if (!(await deps.getBoolSetting(ENABLED_KEY))) return { sent: false, reason: "muted" };
    if (!(await deps.emailedEvents()).includes(input.event)) return { sent: false, reason: "event_muted" };
    const sb = deps.serviceClient();
    let company: string | null = null;
    let sentMap: Record<string, string> = {};

    if (input.tenant_id) {
      const { data: tenant, error } = await sb
        .from("tenants")
        .select("slug, display_name, kind")
        .eq("id", input.tenant_id)
        .maybeSingle();
      if (error) return { sent: false, reason: `tenant_read_failed: ${error.message}` };
      if (!tenant) return { sent: false, reason: "tenant_not_found" };
      if (tenant.kind === "test" || DOGFOOD_SLUGS.has(tenant.slug)) {
        if (memoKey) settled.add(memoKey);
        return { sent: false, reason: tenant.kind === "test" ? "skipped_test_tenant" : "skipped_dogfood_tenant" };
      }
      company = tenant.display_name ?? tenant.slug ?? null;

      if (key) {
        const { data: row, error: readErr } = await sb
          .from("tenant_app_setting")
          .select("value")
          .eq("tenant_id", input.tenant_id)
          .eq("key", SENT_KEY)
          .maybeSingle();
        if (readErr) return { sent: false, reason: `sent_map_read_failed: ${readErr.message}` };
        const v = row?.value;
        if (v && typeof v === "object" && !Array.isArray(v)) sentMap = v as Record<string, string>;
        if (sentMap[key]) {
          if (memoKey) settled.add(memoKey);
          return { sent: false, reason: "already_sent" };
        }
      }
    }

    let email = input.email ?? null;
    if (!email && input.user_id) {
      try {
        const { data: u } = await sb.auth.admin.getUserById(input.user_id);
        email = u?.user?.email ?? null;
      } catch {
      }
    }

    const rendered = renderFounderAlert({
      event: input.event,
      company,
      email,
      tenant_id: input.tenant_id ?? null,
      details: input.details ?? {},
      at: now.toISOString(),
    });
    let delivered = 0;
    for (const to of founderAlertRecipients()) {
      try {
        await deps.sgSend(to, rendered.subject, rendered.html, rendered.text);
        delivered++;
      } catch (e) {
        console.warn(`[founder-alert] send to ${to} failed: ${(e as Error).message}`);
      }
    }
    if (delivered === 0) return { sent: false, reason: "send_failed" };

    if (input.tenant_id && key) {
      await deps.setTenantSetting(
        input.tenant_id,
        SENT_KEY,
        { ...sentMap, [key]: now.toISOString() },
        input.user_id ?? "system",
      );
      if (memoKey) settled.add(memoKey);
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
