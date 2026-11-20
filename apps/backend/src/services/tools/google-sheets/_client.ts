
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { googleSheetsClientId, googleSheetsClientSecret, GOOGLE_SHEETS_VAULT_KEYS } from "./keys";

export const SHEETS_API = "https://sheets.googleapis.com/v4";

type AccessTokenCache = { access_token: string; expires_at_ms: number };
const ACCESS_TOKEN_CACHE = new Map<string, AccessTokenCache>();

async function getAccessToken(tenant_id: string): Promise<string> {
  const clientId = googleSheetsClientId();
  const clientSecret = googleSheetsClientSecret();
  const refreshToken = await getSecret(tenant_id, GOOGLE_SHEETS_VAULT_KEYS.refresh_token);

  if (!clientId || !clientSecret) {
    throw new ExpectedToolError(
      "google_sheets_not_configured",
      "Google Sheets is not configured on this Praxis deployment. The GOOGLE_SHEETS_CLIENT_ID / GOOGLE_SHEETS_CLIENT_SECRET env secrets (or the reused GOOGLE_ADS_* pair) are unset.",
      { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_SHEETS_* (or GOOGLE_ADS_*) OAuth client env secrets in AWS Secrets Manager praxis-envprod-1"] },
    );
  }
  if (!refreshToken) {
    throw new ExpectedToolError(
      "google_sheets_not_connected",
      "Google Sheets is not connected for this workspace. Operator must complete the OAuth flow at /connectors → Google Sheets. Until connected, spreadsheet reads are unavailable.",
      { next_step: "operator_action", unblockers: ["Complete OAuth at /connectors → Google Sheets"] },
    );
  }

  return getOrRefreshAccessToken(tenant_id, clientId, clientSecret, refreshToken);
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    throw new ExpectedToolError("google_sheets_oauth_refresh_failed", `Google OAuth refresh failed: ${r.status}`);
  }
  const json = (await r.json()) as { access_token: string; expires_in?: number };
  const cache: AccessTokenCache = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + (json.expires_in ?? 3000) * 1000,
  };
  ACCESS_TOKEN_CACHE.set(tenant_id, cache);
  return cache.access_token;
}

export type SheetTab = {
  sheet_id: number;
  title: string;
  hidden: boolean;
  row_count: number;
  col_count: number;
};

export async function getSpreadsheetTabs(tenant_id: string, spreadsheet_id: string): Promise<SheetTab[]> {
  const accessToken = await getAccessToken(tenant_id);
  let r: Response;
  try {
    r = await fetch(
      `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheet_id)}?fields=sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_sheets_api_timeout", "Sheets API did not respond within 15s");
    }
    throw e;
  }
  if (r.status === 404 || r.status === 403) {
    throw new ExpectedToolError(
      "google_sheets_access_denied",
      "That spreadsheet was not found or the connected Google account can't open it. Confirm the spreadsheet_id and that the connected account has at least Viewer access.",
    );
  }
  if (!r.ok) {
    throw new ExpectedToolError("google_sheets_list_tabs_failed", `Sheets API returned ${r.status}`);
  }
  const json = (await r.json()) as {
    sheets?: Array<{
      properties: {
        sheetId: number;
        title: string;
        hidden?: boolean;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  };
  return (json.sheets ?? []).map((s) => ({
    sheet_id: s.properties.sheetId,
    title: s.properties.title,
    hidden: s.properties.hidden ?? false,
    row_count: s.properties.gridProperties?.rowCount ?? 0,
    col_count: s.properties.gridProperties?.columnCount ?? 0,
  }));
}

export type SheetRangeValues = {
  range: string;
  values: unknown[][];
};

export async function getRangeValues(
  tenant_id: string,
  spreadsheet_id: string,
  range: string,
): Promise<SheetRangeValues> {
  const accessToken = await getAccessToken(tenant_id);
  let r: Response;
  try {
    r = await fetch(
      `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_sheets_api_timeout", "Sheets API did not respond within 15s");
    }
    throw e;
  }
  if (r.status === 404 || r.status === 403) {
    throw new ExpectedToolError(
      "google_sheets_access_denied",
      "That spreadsheet was not found or the connected Google account can't open it. Confirm the spreadsheet_id and that the connected account has at least Viewer access.",
    );
  }
  if (r.status === 400) {
    throw new ExpectedToolError(
      "google_sheets_invalid_range",
      "Google rejected that range. Use A1 notation, e.g. 'Sheet1!A1:D50' — quote the tab name if it has spaces.",
    );
  }
  if (!r.ok) {
    throw new ExpectedToolError("google_sheets_read_range_failed", `Sheets API returned ${r.status}`);
  }
  const json = (await r.json()) as { range?: string; values?: unknown[][] };
  return { range: json.range ?? range, values: json.values ?? [] };
}
