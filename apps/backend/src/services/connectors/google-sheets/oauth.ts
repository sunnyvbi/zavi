
import { ExpectedToolError } from "../../tools/types";
import {
  googleSheetsClientId,
  googleSheetsClientSecret,
  GOOGLE_SHEETS_SCOPE,
} from "../../tools/google-sheets/keys";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleSheetsOAuthCreds = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

export function googleSheetsOAuthCreds(): GoogleSheetsOAuthCreds {
  const client_id = googleSheetsClientId();
  const client_secret = googleSheetsClientSecret();
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!client_id || !client_secret || !backend_url) {
    throw new Error(
      "google_sheets_misconfigured: set GOOGLE_SHEETS_CLIENT_ID/SECRET " +
        "(or reuse GOOGLE_ADS_CLIENT_ID/SECRET) and BACKEND_PUBLIC_URL. The " +
        "OAuth client must list /api/connectors/google-sheets/callback as an " +
        "authorized redirect URI and request the spreadsheets.readonly scope.",
    );
  }
  return {
    client_id,
    client_secret,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/google-sheets/callback`,
  };
}

export function googleSheetsOAuthStartUrl(state: string): string {
  const creds = googleSheetsOAuthCreds();
  const sp = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    response_type: "code",
    scope: GOOGLE_SHEETS_SCOPE,
    access_type: "offline",
    prompt: "select_account consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${sp.toString()}`;
}

export async function exchangeCode(
  code: string,
): Promise<{ refresh_token?: string; access_token: string; expires_in: number }> {
  const creds = googleSheetsOAuthCreds();
  const body = new URLSearchParams({
    code,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: creds.redirect_uri,
    grant_type: "authorization_code",
  });
  let r: Response;
  try {
    r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_oauth_timeout", "Google token endpoint did not respond within 10s");
    }
    throw e;
  }
  if (!r.ok) {
    throw new ExpectedToolError("google_oauth_exchange_failed", `Google token exchange returned ${r.status}`);
  }
  return (await r.json()) as { refresh_token?: string; access_token: string; expires_in: number };
}
