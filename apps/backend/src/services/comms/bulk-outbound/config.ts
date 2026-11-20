
import { globalClient } from "@/services/tenant-client";
import { BulkEmailError } from "./errors";

export const BULK_NOT_CONFIGURED_CODE = "bulk_sender_not_configured";
export const BULK_NOT_CONFIGURED_SENTENCE = "Bulk email is not set up yet.";

export function bulkSendgridKey(): string | null {
  const key = process.env.BULK_SENDGRID_API_KEY?.trim();
  return key ? key : null;
}

export function requireBulkSendgridKey(): string {
  const key = bulkSendgridKey();
  if (!key) throw new BulkEmailError(BULK_NOT_CONFIGURED_CODE, BULK_NOT_CONFIGURED_SENTENCE, 503);
  return key;
}

export async function bulkSendingStoppedGlobally(): Promise<boolean> {
  return (await readGlobalBulkStop()) !== "running";
}

export type GlobalBulkStop = "stopped" | "running" | "unreadable";

export function bulkSendSettingState(value: unknown): GlobalBulkStop {
  if (value === undefined || value === null || value === true) return "running";
  if (value === false) return "stopped";
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") return "running";
    if (text === "false") return "stopped";
  }
  return "unreadable";
}

async function readBulkSendSetting(): Promise<GlobalBulkStop> {
  const { data, error } = await globalClient()
    .from("app_setting")
    .select("value")
    .eq("key", "bulk_email_send_enabled")
    .maybeSingle();
  if (error) return "unreadable";
  return bulkSendSettingState((data as { value?: unknown } | null)?.value);
}

async function readSystemConfigStop(): Promise<GlobalBulkStop> {
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
  if (error) return "unreadable";
  const blob = ((data as { blob?: Record<string, unknown> } | null)?.blob ?? {}) as Record<string, unknown>;
  return bulkSendSettingState(blob.bulk_email_send_enabled);
}

export async function readGlobalBulkStop(): Promise<GlobalBulkStop> {
  const states = await Promise.all([
    readBulkSendSetting().catch((): GlobalBulkStop => "unreadable"),
    readSystemConfigStop().catch((): GlobalBulkStop => "unreadable"),
  ]);
  if (states.includes("stopped")) return "stopped";
  if (states.includes("unreadable")) return "unreadable";
  return "running";
}

export { BULK_COHORT_HARD_CAP } from "./cohort";
export const LIST_VERSION_MAX_CONTACTS = 10_000;
export const DATABASE_IMPORT_MAX_ROWS = 5_000;
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CONSENT_SENTENCE = "These people agreed to hear from me.";

export const ABUSE_COMPLAINTS_ANY = 5;
export const ABUSE_MIN_SENT = 200;
export const ABUSE_COMPLAINT_RATE = 0.003;
export const ABUSE_HARD_BOUNCE_RATE = 0.05;
