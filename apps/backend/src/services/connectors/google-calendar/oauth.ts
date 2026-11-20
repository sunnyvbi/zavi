
import { ExpectedToolError } from "../../tools/types";
import {
  googleCalendarClientId,
  googleCalendarClientSecret,
  GOOGLE_CALENDAR_SCOPE,
} from "../../tools/google-calendar/keys";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type GoogleCalendarOAuthCreds = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

export function googleCalendarOAuthCreds(): GoogleCalendarOAuthCreds {
  const client_id = googleCalendarClientId();
  const client_secret = googleCalendarClientSecret();
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!client_id || !client_secret || !backend_url) {
    throw new Error(
      "google_calendar_misconfigured: set GOOGLE_CALENDAR_CLIENT_ID/SECRET " +
        "(or reuse GOOGLE_ADS_CLIENT_ID/SECRET) and BACKEND_PUBLIC_URL. The " +
        "OAuth client must list /api/connectors/google-calendar/callback as an " +
        "authorized redirect URI and request the calendar.readonly scope.",
    );
  }
  return {
    client_id,
    client_secret,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/google-calendar/callback`,
  };
}

export function googleCalendarOAuthStartUrl(state: string): string {
  const creds = googleCalendarOAuthCreds();
  const sp = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
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
  const creds = googleCalendarOAuthCreds();
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
    console.error("google_calendar_oauth_exchange_failed", { status: r.status });
    throw new ExpectedToolError(
      "google_oauth_exchange_failed",
      `Google token exchange returned ${r.status}`,
    );
  }
  return (await r.json()) as { refresh_token?: string; access_token: string; expires_in: number };
}

export type GoogleCalendarSummary = { calendar_id: string; display_name: string; primary: boolean };

export async function listAccessibleCalendars(accessToken: string): Promise<GoogleCalendarSummary[]> {
  const out: GoogleCalendarSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("minAccessRole", "reader");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let r: Response;
    try {
      r = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ExpectedToolError("google_calendar_api_timeout", "Calendar API did not respond within 10s");
      }
      throw e;
    }
    if (!r.ok) {
      console.error("google_calendar_list_calendars_failed", { status: r.status });
      throw new ExpectedToolError(
        "google_calendar_list_calendars_failed",
        `calendarList.list returned ${r.status}`,
      );
    }
    const json = (await r.json()) as {
      items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
      nextPageToken?: string;
    };
    for (const cal of json.items ?? []) {
      if (!cal.id) continue;
      out.push({
        calendar_id: cal.id,
        display_name: cal.summary ?? cal.id,
        primary: cal.primary === true,
      });
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}
