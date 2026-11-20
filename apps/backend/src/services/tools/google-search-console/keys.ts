export const GOOGLE_SEARCH_CONSOLE_VAULT_KEYS = {
  refresh_token: "google_search_console.refresh_token",
  site_url: "google_search_console.site_url",
} as const;

export const GOOGLE_SEARCH_CONSOLE_REQUIRED_VAULT_KEYS = [
  GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.refresh_token,
  GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url,
] as const;

export function googleSearchConsoleClientId(): string | undefined {
  return process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
}
export function googleSearchConsoleClientSecret(): string | undefined {
  return process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
}

export const GOOGLE_SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
