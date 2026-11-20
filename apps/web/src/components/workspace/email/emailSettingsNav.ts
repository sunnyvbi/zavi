import { EMAIL_SETTINGS_GOTO_EVENT } from "@/lib/workspace/emailCampaignSettingsApi";

export { EMAIL_SETTINGS_GOTO_EVENT };

export type EmailSettingsSection = "contacts" | "sending" | "footer" | "autopilot" | "brand" | "notes" | "brief";

export const emailSettingsAnchor = (section: EmailSettingsSection) => `email-settings-${section}`;

let askedSection: EmailSettingsSection | null = null;
let askedSectionAt = 0;

export function gotoEmailSettings(section: EmailSettingsSection): void {
  askedSection = section;
  askedSectionAt = Date.now();
  window.dispatchEvent(new CustomEvent(EMAIL_SETTINGS_GOTO_EVENT, { detail: { section } }));
}

export const OPEN_DATABASE_IMPORT_EVENT = "zavi:email-open-database-import";
const REQUEST_TTL_MS = 10_000;
let databaseImportAskedAt = 0;

export function askedEmailSettingsSection(): EmailSettingsSection | null {
  return askedSection && Date.now() - askedSectionAt < REQUEST_TTL_MS ? askedSection : null;
}

export function clearAskedEmailSettingsSection(): void {
  askedSection = null;
}

export function requestDatabaseImport(): void {
  databaseImportAskedAt = Date.now();
  gotoEmailSettings("contacts");
  window.dispatchEvent(new CustomEvent(OPEN_DATABASE_IMPORT_EVENT));
}

export function takeDatabaseImportRequest(): boolean {
  const asked = databaseImportAskedAt > 0 && Date.now() - databaseImportAskedAt < REQUEST_TTL_MS;
  databaseImportAskedAt = 0;
  return asked;
}
