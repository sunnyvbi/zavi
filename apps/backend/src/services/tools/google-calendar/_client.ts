
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import {
  GOOGLE_CALENDAR_VAULT_KEYS,
  googleCalendarClientId,
  googleCalendarClientSecret,
} from "./keys";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

type AccessTokenCache = { access_token: string; expires_at_ms: number };
const ACCESS_TOKEN_CACHE = new Map<string, AccessTokenCache>();

export type GoogleCalendarCreds = {
  calendar_id: string;
  access_token: string;
};

export async function googleCalendarCreds(tenant_id: string): Promise<GoogleCalendarCreds> {
  const clientId = googleCalendarClientId();
  const clientSecret = googleCalendarClientSecret();
  const refreshToken = await getSecret(tenant_id, GOOGLE_CALENDAR_VAULT_KEYS.refresh_token);
  const calendarId = await getSecret(tenant_id, GOOGLE_CALENDAR_VAULT_KEYS.calendar_id);

  if (!clientId || !clientSecret) {
    throw new ExpectedToolError(
      "google_calendar_not_configured",
      "Google Calendar is not configured on this Praxis deployment. The GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET env secrets (or the reused GOOGLE_ADS_* pair) are unset.",
      { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_CALENDAR_* (or GOOGLE_ADS_*) OAuth client env secrets in AWS Secrets Manager praxis-envprod-1"] },
    );
  }
  if (!refreshToken || !calendarId) {
    throw new ExpectedToolError(
      "google_calendar_not_connected",
      "Google Calendar is not connected for this workspace. Operator must complete the OAuth flow at /connectors → Google Calendar. Until connected, calendar reads are unavailable.",
      { next_step: "operator_action", unblockers: ["Complete OAuth at /connectors → Google Calendar"] },
    );
  }

  const accessToken = await getOrRefreshAccessToken(tenant_id, clientId, clientSecret, refreshToken);
  return { calendar_id: calendarId, access_token: accessToken };
}

async function getOrRefreshAccessToken(
  tenant_id: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const cached = ACCESS_TOKEN_CACHE.get(tenant_id);
  if (cached && cached.expires_at_ms > Date.now() + 60_000) {
    return cached.access_token;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    console.error("google_calendar_oauth_refresh_failed", { tenant_id, status: r.status });
    throw new ExpectedToolError(
      "google_calendar_oauth_refresh_failed",
      `Google OAuth refresh failed: ${r.status}`,
    );
  }
  const json = (await r.json()) as { access_token: string; expires_in?: number };
  const cache: AccessTokenCache = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + (json.expires_in ?? 3000) * 1000,
  };
  ACCESS_TOKEN_CACHE.set(tenant_id, cache);
  return cache.access_token;
}

export type GCalEventAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
};

export type GCalEvent = {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GCalEventAttendee[];
};

export type GCalListEventsResponse = {
  items?: GCalEvent[];
  nextPageToken?: string;
};

export type ListEventsParams = {
  timeMin: string;
  timeMax: string;
  maxResults: number;
};

export async function listEvents(tenant_id: string, params: ListEventsParams): Promise<GCalListEventsResponse> {
  const creds = await googleCalendarCreds(tenant_id);
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(creds.calendar_id)}/events`);
  url.searchParams.set("timeMin", params.timeMin);
  url.searchParams.set("timeMax", params.timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(params.maxResults));

  let r: Response;
  try {
    r = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_calendar_api_timeout", "Calendar API did not respond within 15s");
    }
    throw e;
  }
  if (!r.ok) {
    console.error("google_calendar_list_events_failed", { tenant_id, status: r.status });
    throw new ExpectedToolError(
      "google_calendar_list_events_failed",
      `Calendar events.list returned ${r.status}`,
    );
  }
  return (await r.json()) as GCalListEventsResponse;
}
