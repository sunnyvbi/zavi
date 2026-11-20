
import { apiFetch } from "@/lib/api";
import type { CardOutcome } from "@/lib/workspace/emailPlanApi";

export type ResultCell = { value: number | null; why: string | null; action?: "connect_ga" };

export type SentEmail = {
  card: { rail: "channel_actions" | "decisions"; id: string; link: string };
  route: "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
  sent_with: string;
  subject: string;
  list_id?: string | null;
  delivery?: "unconfirmed" | "reached" | "nobody" | null;
  delivery_reason?: string | null;
  delivery_skipped?: number;
  list_name: string | null;
  timezone?: string;
  started_at: string | null;
  finished_at: string | null;
  spanned: boolean;
  stage: "sending" | "paused" | "h1_due" | "h1" | "d7";
  people: { sent: number | null; total: number | null; stopped: boolean };
  as_of: "h1" | "d7" | null;
  delivered: ResultCell;
  opens: ResultCell;
  opens_label: string;
  opens_unique?: boolean;
  clicks: ResultCell;
  unsubscribes: ResultCell;
  visitors: ResultCell;
  win_line: { text: string; metric: string | null; threshold: number | null; basis: string };
  verdict: "beat" | "below" | "baseline" | "no_signal" | "unknown" | null;
  verdict_text: string;
  d7_due_at: string | null;
  note: string | null;
  numbers_note?: string | null;
  stop_note?: string | null;
  outcome?: CardOutcome | null;
};

export async function getGaConnected(): Promise<boolean | null> {
  try {
    const res = await apiFetch("/api/connectors");
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { connectors?: Array<{ slug?: string }> } | null;
    return Array.isArray(body?.connectors) ? body.connectors.some((c) => c.slug === "google_analytics") : null;
  } catch {
    return null;
  }
}

export async function getSentEmails(): Promise<SentEmail[]> {
  return (await getSentEmailsPage()).emails;
}

export async function getSentEmailsPage(limit?: number): Promise<{ emails: SentEmail[]; more: boolean }> {
  let res: Response;
  try {
    res = await apiFetch(limit ? `/api/email-results?limit=${limit}` : "/api/email-results");
  } catch {
    throw new Error("We could not reach Zavi. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { emails?: SentEmail[]; more?: boolean; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? "Sent emails could not be loaded. Try again.");
  return { emails: Array.isArray(body?.emails) ? body.emails : [], more: body?.more === true };
}
