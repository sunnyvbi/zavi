
import dotenv from "dotenv";

export function parseEnvKeys(text: string, keys: readonly string[]): Record<string, string> {
  const all = dotenv.parse(text);
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof all[k] === "string" && all[k] !== "") out[k] = all[k];
  return out;
}

export const PROD_APP_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ANALYTICS_CLIENT_ID",
  "GOOGLE_ANALYTICS_CLIENT_SECRET",
  "GOOGLE_SEARCH_CONSOLE_CLIENT_ID",
  "GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET",
  "GOOGLE_SHEETS_CLIENT_ID",
  "GOOGLE_SHEETS_CLIENT_SECRET",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "COMPOSIO_API_KEY",
  "COMPOSIO_MCP_SERVER_ID",
  "COMPOSIO_AUTH_CONFIGS",
  "PIPEDREAM_CLIENT_ID",
  "PIPEDREAM_CLIENT_SECRET",
  "PIPEDREAM_PROJECT_ID",
  "PIPEDREAM_ENVIRONMENT",
  "PRAXIS_VAULT_KEY",
  "META_APP_ID",
  "META_APP_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "JIRA_CLIENT_ID",
  "JIRA_CLIENT_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "INTERCOM_CLIENT_ID",
  "INTERCOM_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "LINKEDIN_ADS_CLIENT_ID",
  "LINKEDIN_ADS_CLIENT_SECRET",
  "LINKEDIN_SOCIAL_CLIENT_ID",
  "LINKEDIN_SOCIAL_CLIENT_SECRET",
  "INSTAGRAM_SOCIAL_CLIENT_ID",
  "INSTAGRAM_SOCIAL_CLIENT_SECRET",
  "MICROSOFT_ADS_CLIENT_ID",
  "MICROSOFT_ADS_CLIENT_SECRET",
  "MICROSOFT_ADS_DEVELOPER_TOKEN",
  "PINTEREST_ADS_CLIENT_ID",
  "PINTEREST_ADS_CLIENT_SECRET",
  "REDDIT_ADS_CLIENT_ID",
  "REDDIT_ADS_CLIENT_SECRET",
  "REDDIT_API_CLIENT_ID",
  "REDDIT_API_CLIENT_SECRET",
  "REDDIT_SOCIAL_CLIENT_ID",
  "REDDIT_SOCIAL_CLIENT_SECRET",
  "SNAPCHAT_ADS_CLIENT_ID",
  "SNAPCHAT_ADS_CLIENT_SECRET",
  "SPOTIFY_ADS_CLIENT_ID",
  "SPOTIFY_ADS_CLIENT_SECRET",
  "TIKTOK_ADS_APP_ID",
  "TIKTOK_ADS_SECRET",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "X_ADS_CONSUMER_KEY",
  "X_ADS_CONSUMER_SECRET",
  "X_SOCIAL_CLIENT_ID",
  "X_SOCIAL_CLIENT_SECRET",
  "HIGGSFIELD_OAUTH_CLIENT_ID",
  "HIGGSFIELD_OAUTH_CLIENT_SECRET",
  "OPENAI_ADS_API_KEY",
  "YOUTUBE_DATA_API_KEY",
] as const;

export function normalizePemValue(raw: string): string {
  const m = /^\s*(-----BEGIN [A-Z0-9 ]+-----)([\s\S]*?)(-----END [A-Z0-9 ]+-----)\s*$/.exec(raw);
  if (!m) return raw;
  const body = m[2].replace(/\\n/g, "").replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `${m[1]}\n${wrapped}\n${m[3]}\n`;
}

export function applyProdAppKeys(
  env: Record<string, string | undefined>,
  prod: Record<string, string>,
  keys: readonly string[] = PROD_APP_KEYS,
): { from_prod: string[]; still_staging: string[] } {
  const from_prod: string[] = [];
  const still_staging: string[] = [];
  for (const k of keys) {
    if (prod[k]) {
      env[k] = k.endsWith("_PRIVATE_KEY") ? normalizePemValue(prod[k]) : prod[k];
      from_prod.push(k);
    } else if (env[k]) {
      still_staging.push(k);
    }
  }
  return { from_prod, still_staging };
}

export function supabaseProjectRef(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const m = /^([a-z0-9]+)\.supabase\.co$/.exec(u.hostname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
