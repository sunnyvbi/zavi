
import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { PLAN_FALLBACK } from "@/lib/workspace/emailPlanApi";

export class EmailSettingsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EmailSettingsError";
  }
}

const FALLBACK = "Something went wrong. Try again.";

export function readFailureMessage(e: unknown, specific: string): string {
  const message = e instanceof Error ? e.message : "";
  return !message || message === FALLBACK || message === PLAN_FALLBACK ? specific : message;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    throw new EmailSettingsError("network", "We could not reach Zavi. Check your connection and try again.", 0);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new EmailSettingsError(body?.error?.code ?? "error", body?.error?.message ?? FALLBACK, res.status);
  return body as T;
}

const CHANNEL = "email_marketing";

export type SendgridSender = { id: string; from_email: string; from_name: string | null; verified: boolean };
export type SendgridGroup = { id: string; name: string; is_default: boolean };
export type SendgridList = { id: string; name: string; people: number | null };

export const getSendgridSenders = () => request<{ senders: SendgridSender[] }>("/api/workspace/sendgrid/senders").then((r) => (Array.isArray(r?.senders) ? r.senders : []));
export const getSendgridGroups = () => request<{ groups: SendgridGroup[] }>("/api/workspace/sendgrid/suppression-groups").then((r) => (Array.isArray(r?.groups) ? r.groups : []));
export const getSendgridLists = () => request<{ lists: SendgridList[] }>("/api/workspace/sendgrid/lists").then((r) => (Array.isArray(r?.lists) ? r.lists : []));

export const SENDER_FIELD = "sendgrid_sender_id";
export const GROUP_FIELD = "sendgrid_suppression_group_id";

type SettingRow = { item?: string | null; status?: string | null };

export function liveSettingItems(rows: readonly SettingRow[] | null | undefined): string[] {
  return (Array.isArray(rows) ? rows : []).filter((x) => x.status !== "dismissed" && x.status !== "paused" && typeof x.item === "string").map((x) => x.item as string);
}

export async function getEmailChannelSettings(): Promise<Record<string, string[]>> {
  const r = await request<{ fields?: Record<string, SettingRow[]> }>(`/api/channels/${CHANNEL}/settings`);
  const out: Record<string, string[]> = {};
  for (const [field, rows] of Object.entries(r?.fields ?? {})) out[field] = liveSettingItems(rows);
  return out;
}

export function saveEmailChannelSetting(fieldId: string, items: string[]): Promise<unknown> {
  return request(`/api/channels/${CHANNEL}/settings/${encodeURIComponent(fieldId)}`, { method: "PUT", body: JSON.stringify({ items }) });
}

export type TestListRoute = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
export type TestListRow = { id: string; name: string; people: number | null; marked: boolean; looks_like_test: boolean; needs_consent?: true; consented_version?: true };
export type TestListRouteView = {
  route: TestListRoute;
  label: string;
  status: "complete" | "partial" | "unreadable" | "not_connected" | "needs_permissions";
  error: string | null;
  lists: TestListRow[];
};
export type OrphanMark = { route: TestListRoute; list_id: string; reason: "not_found" | "not_checked"; can_unmark: boolean; note: string };

export type GmailSenderView = { status: "connected" | "not_connected" | "unreadable" };
export type EmailTestListsView = { routes: TestListRouteView[]; orphans: OrphanMark[]; gmail?: GmailSenderView };

export const EMAIL_TEST_LISTS_FRESH_MS = 25_000;

type TestListsRead = { at: number; done: boolean; result: Promise<EmailTestListsView> };
let testListsRead: TestListsRead | null = null;

export function forgetEmailTestLists(): void {
  testListsRead = null;
}

(globalThis as { __zaviForgetEmailTestLists?: () => void }).__zaviForgetEmailTestLists = forgetEmailTestLists;

export function getEmailTestLists(opts: { fresh?: boolean } = {}): Promise<EmailTestListsView> {
  if (opts.fresh) forgetEmailTestLists();
  const held = testListsRead;
  if (held && (!held.done || Date.now() - held.at < EMAIL_TEST_LISTS_FRESH_MS)) return held.result;
  registerSessionScopedCache(forgetEmailTestLists);
  const entry: TestListsRead = { at: Date.now(), done: false, result: request<EmailTestListsView>("/api/workspace/email-test-lists") };
  testListsRead = entry;
  entry.result.then(
    () => {
      if (testListsRead !== entry) return;
      entry.done = true;
      entry.at = Date.now();
    },
    () => {
      if (testListsRead === entry) testListsRead = null;
    },
  );
  return entry.result;
}

export const setEmailTestList = (route: TestListRoute, listId: string, marked: boolean) =>
  request<{ ok: true; changed: boolean; marked: boolean }>("/api/workspace/email-test-lists", {
    method: "POST",
    body: JSON.stringify({ route, list_id: listId, marked }),
  }).finally(forgetEmailTestLists);

export type EmailTemplate = {
  logo_url: string | null;
  brand_color: string;
  button_color: string;
  font_key: string;
  sign_off: string;
  postal_address: string | null;
  show_cards: boolean;
};

export const getEmailTemplate = () =>
  request<{ template: (EmailTemplate & { updated_at?: string }) | null; fonts: string[]; can_edit: boolean }>("/api/workspace/email-template");
export const draftEmailTemplate = () => request<{ draft: EmailTemplate & { company_name?: string | null } }>("/api/workspace/email-template/draft", { method: "POST" });
export const saveEmailTemplate = (t: EmailTemplate) =>
  request<{ template: EmailTemplate }>("/api/workspace/email-template", { method: "PUT", body: JSON.stringify(t) });

export type EmailAutoSend = { on: boolean; autopilot: boolean | null };

export async function getEmailAutoSend(): Promise<EmailAutoSend> {
  const r = await request<{
    channels?: Array<{ slug: string; autorun?: boolean }>;
    head_of_growth?: { autopilot?: unknown };
    unreadable?: string[];
  }>("/api/workspace/growth/plan");
  const autopilot = r?.head_of_growth?.autopilot;
  return {
    on: r?.channels?.find((c) => c.slug === CHANNEL)?.autorun === true,
    autopilot: typeof autopilot === "boolean" && !r?.unreadable?.includes("head_of_growth") ? autopilot : null,
  };
}

export const setEmailAutoSend = (on: boolean) =>
  request(`/api/workspace/growth/channels/${CHANNEL}/autorun`, { method: "POST", body: JSON.stringify({ autorun: on }) });

export const EMAIL_SEND_HOLDS = ["abuse", "global", "disabled", "unknown"] as const;
export type EmailSendHold = (typeof EMAIL_SEND_HOLDS)[number];
export type EmailPauseState = { paused: boolean; held: EmailSendHold | null };

const isEmailSendHold = (v: unknown): v is EmailSendHold => (EMAIL_SEND_HOLDS as readonly unknown[]).includes(v);

function heldOf(v: unknown): EmailSendHold | null {
  if (v === null || v === undefined) return null;
  return isEmailSendHold(v) ? v : "unknown";
}

export const getEmailPause = () =>
  request<{ paused: boolean; held?: unknown }>("/api/workspace/email-pause").then(
    (r): EmailPauseState => ({ paused: r?.paused === true, held: heldOf(r?.held) }),
  );

export const setEmailPause = (paused: boolean) =>
  request<{ paused?: boolean }>("/api/workspace/email-pause", { method: "POST", body: JSON.stringify({ paused }) }).then((r) => (typeof r?.paused === "boolean" ? r.paused : paused));

export const SENDGRID_CONNECTED_EVENT = "zavi:sendgrid-connected";

if (typeof window !== "undefined") window.addEventListener(SENDGRID_CONNECTED_EVENT, forgetEmailTestLists);

export const EMAIL_FOOTER_SAVED_EVENT = "zavi:email-footer-saved";
export const EMAIL_SETTINGS_GOTO_EVENT = "zavi:email-settings-goto";
export const POSTAL_FIELD = "postal_address";
export const UNSUBSCRIBE_FIELD = "unsubscribe_link";

export function goToEmailFooterSettings(): void {
  window.dispatchEvent(new CustomEvent(EMAIL_SETTINGS_GOTO_EVENT, { detail: { section: "footer" } }));
}

export async function saveTemplatePostalAddress(address: string): Promise<EmailTemplate> {
  const current = await getEmailTemplate();
  let base: EmailTemplate;
  if (current?.template && typeof current.template === "object") {
    const { logo_url, brand_color, button_color, font_key, sign_off, postal_address, show_cards } = current.template;
    base = { logo_url, brand_color, button_color, font_key, sign_off, postal_address, show_cards };
  } else {
    const { draft } = await draftEmailTemplate();
    const { logo_url, brand_color, button_color, font_key, sign_off, postal_address, show_cards } = draft;
    base = { logo_url, brand_color, button_color, font_key, sign_off, postal_address, show_cards };
  }
  const { template } = await saveEmailTemplate({ ...base, postal_address: address });
  return template;
}
