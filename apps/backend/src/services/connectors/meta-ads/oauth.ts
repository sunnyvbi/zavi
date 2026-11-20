
import { ExpectedToolError } from "@/services/tools/types";

const AUTHORIZE_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const FB_BASE = "https://graph.facebook.com/v25.0";

export type MetaCreds = {
  app_id: string;
  app_secret: string;
  config_id: string;
  redirect_uri: string;
};

export function metaCreds(): MetaCreds {
  const app_id = process.env.META_APP_ID;
  const app_secret = process.env.META_APP_SECRET;
  const config_id = process.env.META_LOGIN_CONFIG_ID;
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!app_id || !app_secret || !config_id || !backend_url) {
    throw new Error(
      "meta_ads_misconfigured: set META_APP_ID, META_APP_SECRET, " +
        "META_LOGIN_CONFIG_ID, and BACKEND_PUBLIC_URL. See plan §Env vars.",
    );
  }
  return {
    app_id,
    app_secret,
    config_id,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/meta-ads/callback`,
  };
}

async function graphApiCall<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = `${FB_BASE}/${path}?${new URLSearchParams(params).toString()}`;
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError(
        "meta_graph_api_timeout",
        `Meta Graph API ${path} did not respond within 10s`,
      );
    }
    throw e;
  }
  if (!r.ok) {
    const body = await r.text();
    throw new ExpectedToolError(
      "meta_graph_api_failed",
      `Meta Graph API ${path} returned ${r.status}: ${body.slice(0, 300)}`,
    );
  }
  return (await r.json()) as T;
}

export function metaOAuthStartUrl(state: string): string {
  const creds = metaCreds();
  const sp = new URLSearchParams({
    client_id: creds.app_id,
    config_id: creds.config_id,
    redirect_uri: creds.redirect_uri,
    state,
    response_type: "code",
    override_default_response_type: "true",
  });
  return `${AUTHORIZE_URL}?${sp.toString()}`;
}

export async function exchangeCode(code: string): Promise<{ access_token: string; expires_in: number }> {
  const creds = metaCreds();
  return graphApiCall<{ access_token: string; expires_in: number }>(
    "oauth/access_token",
    {
      client_id: creds.app_id,
      client_secret: creds.app_secret,
      redirect_uri: creds.redirect_uri,
      code,
    },
  );
}

export async function exchangeForLongLivedToken(
  shortToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const creds = metaCreds();
  return graphApiCall<{ access_token: string; expires_in: number }>(
    "oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: creds.app_id,
      client_secret: creds.app_secret,
      fb_exchange_token: shortToken,
    },
  );
}

export type MetaTokenDebug = {
  is_valid: boolean;
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[];
};

function unixToDate(v: unknown): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v * 1000);
}

export async function debugToken(inputToken: string): Promise<MetaTokenDebug> {
  const creds = metaCreds();
  const res = await graphApiCall<{
    data?: {
      is_valid?: boolean;
      expires_at?: number;
      data_access_expires_at?: number;
      scopes?: string[];
    };
  }>("debug_token", {
    input_token: inputToken,
    access_token: `${creds.app_id}|${creds.app_secret}`,
  });
  const d = res.data ?? {};
  return {
    is_valid: d.is_valid === true,
    expires_at: unixToDate(d.expires_at),
    data_access_expires_at: unixToDate(d.data_access_expires_at),
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
  };
}

export type MetaAdAccount = {
  id: string;
  account_id: string;
  name: string;
  account_status: number;
  currency: string;
};

export async function listAdAccounts(longToken: string): Promise<MetaAdAccount[]> {
  const res = await graphApiCall<{ data: MetaAdAccount[]; paging?: { next?: string } }>(
    "me/adaccounts",
    {
      fields: "id,account_id,name,account_status,currency",
      limit: "50",
      access_token: longToken,
    },
  );
  if (res.paging?.next) {
    console.warn(
      "[meta-ads] /me/adaccounts paged: operator has >50 accounts, showing first 50 ACTIVE",
    );
  }
  return res.data.filter((a) => a.account_status === 1);
}

export async function verifyAccountReadable(
  longToken: string,
  adAccountId: string,
): Promise<void> {
  await graphApiCall(`${adAccountId}/insights`, {
    access_token: longToken,
    fields: "spend",
    date_preset: "yesterday",
    limit: "1",
  });
}
