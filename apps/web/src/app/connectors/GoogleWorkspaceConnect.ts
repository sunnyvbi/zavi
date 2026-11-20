"use client";

import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { rememberConnectReturn } from "./ConnectButton";

async function startGooglePopupConnect(
  routePath: string,
  popupName: string,
  label: string,
): Promise<void> {
  const popup = window.open(
    "about:blank",
    popupName,
    "noopener=no,popup=yes,width=600,height=750",
  );
  if (!popup) {
    showConnectorError({
      title: "Popup blocked",
      message: "Allow popups for this site and try again.",
    });
    return;
  }
  try {
    const res = await apiFetch(`/api/connectors/${routePath}/start`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as {
      oauth_url?: string;
      error?: { code?: string; message?: string };
    };
    if (res.status === 401) {
      popup.close();
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    if (!res.ok || !body.oauth_url) {
      popup.close();
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    rememberConnectReturn();
    popup.location.href = body.oauth_url;
  } catch (e) {
    try {
      popup.close();
    } catch (_) {
    }
    showConnectorError({
      title: `Couldn’t connect ${label}`,
      message: (e as Error).message,
    });
  }
}

export function startGoogleCalendarConnect(): Promise<void> {
  return startGooglePopupConnect("google-calendar", "google_calendar_oauth", "Google Calendar");
}

export function startGoogleSheetsConnect(): Promise<void> {
  return startGooglePopupConnect("google-sheets", "google_sheets_oauth", "Google Sheets");
}
