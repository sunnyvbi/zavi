
export const GOOGLE_CALENDAR_VAULT_KEYS = {
  refresh_token: "google_calendar.refresh_token",
  calendar_id: "google_calendar.calendar_id",
} as const;

export const GOOGLE_CALENDAR_REQUIRED_VAULT_KEYS = [
  GOOGLE_CALENDAR_VAULT_KEYS.refresh_token,
  GOOGLE_CALENDAR_VAULT_KEYS.calendar_id,
] as const;

export function googleCalendarClientId(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
}
export function googleCalendarClientSecret(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
}

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
