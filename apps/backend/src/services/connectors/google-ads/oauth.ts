
import { ExpectedToolError } from "../../tools/types";
import { GOOGLE_ADS_API_BASE } from "../../tools/google-ads/keys";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_API = GOOGLE_ADS_API_BASE;
const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";

export type GoogleAdsOAuthCreds = {
  client_id: string;
  client_secret: string;
  developer_token: string;
  redirect_uri: string;
};

export function googleAdsOAuthCreds(): GoogleAdsOAuthCreds {
  const client_id = process.env.GOOGLE_ADS_CLIENT_ID;
  const client_secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const developer_token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!client_id || !client_secret || !developer_token || !backend_url) {
    throw new Error(
      "google_ads_misconfigured: set GOOGLE_ADS_CLIENT_ID, " +
        "GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN, and " +
        "BACKEND_PUBLIC_URL. See plan §Migration 0082.",
    );
  }
  return {
    client_id,
    client_secret,
    developer_token,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/google-ads/callback`,
  };
}

export function googleAdsOAuthStartUrl(state: string): string {
  const creds = googleAdsOAuthCreds();
  const sp = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    response_type: "code",
    scope: ADWORDS_SCOPE,
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
  const creds = googleAdsOAuthCreds();
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
    throw new ExpectedToolError(
      "google_oauth_exchange_failed",
      `Google token exchange returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  return (await r.json()) as { refresh_token?: string; access_token: string; expires_in: number };
}

export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const creds = googleAdsOAuthCreds();
  let r: Response;
  try {
    r = await fetch(`${ADS_API}/customers:listAccessibleCustomers`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": creds.developer_token,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_ads_api_timeout", "Google Ads API did not respond within 10s");
    }
    throw e;
  }
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_ads_list_customers_failed",
      `listAccessibleCustomers returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  const json = (await r.json()) as { resourceNames?: string[] };
  return (json.resourceNames ?? [])
    .map((rn) => rn.replace(/^customers\//, "").replace(/\D/g, ""))
    .filter((id) => id.length > 0);
}

export function normalizeCustomerId(raw: string): string {
  return raw.replace(/\D/g, "");
}

export type GoogleAdsDiscoveredAccount = {
  customer_id: string;
  login_customer_id: string | null;
  descriptive_name: string;
  manager: boolean;
};

type CustomerClientRow = {
  customerClient?: {
    id?: string;
    descriptiveName?: string;
    manager?: boolean;
    level?: string | number;
    status?: string;
  };
};

async function listCustomerClients(
  accessToken: string,
  loginCustomerId: string,
): Promise<CustomerClientRow[]> {
  const creds = googleAdsOAuthCreds();
  const query =
    "SELECT customer_client.id, customer_client.descriptive_name, " +
    "customer_client.manager, customer_client.level " +
    "FROM customer_client WHERE customer_client.status = 'ENABLED'";
  const r = await fetch(`${ADS_API}/customers/${loginCustomerId}/googleAds:search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": creds.developer_token,
      "login-customer-id": loginCustomerId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_ads_customer_client_failed",
      `customer_client query for ${loginCustomerId} returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  const json = (await r.json()) as { results?: CustomerClientRow[] };
  return json.results ?? [];
}

export async function discoverAdsAccounts(
  accessToken: string,
): Promise<GoogleAdsDiscoveredAccount[]> {
  const loginIds = await listAccessibleCustomers(accessToken);
  const byCustomerId = new Map<string, GoogleAdsDiscoveredAccount>();
  let anyExpansionSucceeded = false;

  for (const loginId of loginIds) {
    let rows: CustomerClientRow[];
    try {
      rows = await listCustomerClients(accessToken, loginId);
    } catch {
      continue;
    }
    anyExpansionSucceeded = true;
    for (const row of rows) {
      const c = row.customerClient;
      const id = normalizeCustomerId(c?.id ?? "");
      if (!id || c?.manager === true) continue;
      const direct = id === loginId;
      const account: GoogleAdsDiscoveredAccount = {
        customer_id: id,
        login_customer_id: direct ? null : loginId,
        descriptive_name: c?.descriptiveName ?? "",
        manager: false,
      };
      const existing = byCustomerId.get(id);
      if (!existing || (existing.login_customer_id !== null && direct)) {
        byCustomerId.set(id, account);
      }
    }
  }

  if (!anyExpansionSucceeded) {
    return loginIds.map((id) => ({
      customer_id: id,
      login_customer_id: null,
      descriptive_name: "",
      manager: false,
    }));
  }
  return [...byCustomerId.values()];
}
