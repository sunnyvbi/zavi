
export const GOOGLE_SHEETS_VAULT_KEYS = {
  refresh_token: "google_sheets.refresh_token",
} as const;

export const GOOGLE_SHEETS_REQUIRED_VAULT_KEYS = [GOOGLE_SHEETS_VAULT_KEYS.refresh_token] as const;

export function googleSheetsClientId(): string | undefined {
  return process.env.GOOGLE_SHEETS_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
}
export function googleSheetsClientSecret(): string | undefined {
  return process.env.GOOGLE_SHEETS_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
}

export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
