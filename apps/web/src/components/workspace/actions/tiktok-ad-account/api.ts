import { apiFetch } from "@/lib/api";

export type AdAccount = {
  advertiser_id: string;
  name: string;
  currency: string | null;
  status: string | null;
  timezone: string | null;
  source: "business_center" | "manual";
};

export type AdAccountsState = {
  connected: boolean;
  accounts: AdAccount[];
  selected_id: string | null;
  needs: "nothing" | "pick" | "paste";
  checked_at: string | null;
};

export class AdAccountError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const BASE = "/api/connectors/tiktok-ads/ad-accounts";

async function call(path: string, body?: unknown): Promise<AdAccountsState> {
  const res = await apiFetch(`${BASE}${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as (AdAccountsState & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok || !json || json.error) {
    throw new AdAccountError(json?.error?.code ?? "failed", json?.error?.message ?? "Something went wrong. Try again.");
  }
  return json;
}

export const loadAdAccounts = () => call("");
export const refreshAdAccounts = () => call("/refresh", {});
export const selectAdAccount = (advertiser_id: string) => call("/select", { advertiser_id });
export const addAdAccount = (input: string) => call("/manual", { input });

export function parseAdAccountInput(input: string): string | null {
  const text = input.trim();
  if (/^\d{6,32}$/.test(text)) return text;
  const m = /[?&#](?:aadvid|advid|advertiser_id)=(\d{6,32})(?:[&#]|$)/i.exec(text);
  return m ? m[1] : null;
}

export const ADS_MANAGER_URL = "https://ads.tiktok.com/i18n/dashboard";
