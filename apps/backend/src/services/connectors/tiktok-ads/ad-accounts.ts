
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { listAdvertiserIds, tiktokAdsAccount, verifyAdvertisers, type TiktokAdvertiser } from "./composio-read";

export const TIKTOK_ADS_ROW_SLUG = "composio.tiktok_ads";

export type AdAccountSource = "business_center" | "manual";
export type SavedAdAccount = TiktokAdvertiser & { source: AdAccountSource };

export type AdAccountsState = {
  connected: boolean;
  accounts: SavedAdAccount[];
  selected_id: string | null;
  needs: "nothing" | "pick" | "paste";
  checked_at: string | null;
};

type Row = {
  team_id: string | null;
  ad_accounts: unknown;
  selected_ad_account_id: string | null;
  ad_accounts_for: string | null;
  ad_accounts_checked_at: string | null;
};

const NOT_CONNECTED: AdAccountsState = { connected: false, accounts: [], selected_id: null, needs: "nothing", checked_at: null };

function parseAccounts(v: unknown): SavedAdAccount[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const r = a as Record<string, unknown>;
    if (typeof r.advertiser_id !== "string" || !/^\d{1,32}$/.test(r.advertiser_id)) return [];
    const s = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
    return [{
      advertiser_id: r.advertiser_id,
      name: s("name") ?? r.advertiser_id,
      currency: s("currency"),
      status: s("status"),
      timezone: s("timezone"),
      source: r.source === "manual" ? "manual" : "business_center",
    }];
  });
}

export function toState(accounts: SavedAdAccount[], selected: string | null, checkedAt: string | null): AdAccountsState {
  const selected_id = selected && accounts.some((a) => a.advertiser_id === selected) ? selected : null;
  const needs = selected_id ? "nothing" : accounts.length === 0 ? "paste" : "pick";
  return { connected: true, accounts, selected_id, needs, checked_at: checkedAt };
}

async function readRow(tenantId: string): Promise<Row | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("connector_metadata")
    .select("team_id, ad_accounts, selected_ad_account_id, ad_accounts_for, ad_accounts_checked_at")
    .eq("slug", TIKTOK_ADS_ROW_SLUG)
    .maybeSingle();
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function save(
  account: OwnedComposioAccount,
  prev: string | null,
  accounts: SavedAdAccount[],
  selected: string | null,
): Promise<AdAccountsState | null> {
  const { data, error } = await tenantRpc(asTenantId(account.tenant_id), "set_connector_ad_accounts", {
    p_slug: TIKTOK_ADS_ROW_SLUG,
    p_for: account.connected_account_id,
    p_accounts: accounts,
    p_selected: selected,
    p_prev_checked_at: prev,
  });
  if (error) throw new Error(`set_connector_ad_accounts failed: ${error.message}`);
  return typeof data === "string" && data ? toState(accounts, selected, data) : null;
}

async function current(account: OwnedComposioAccount): Promise<AdAccountsState> {
  const row = await readRow(account.tenant_id);
  if (row?.team_id !== account.connected_account_id || row.ad_accounts_for !== account.connected_account_id) {
    throw new ExpectedToolError("tiktok_ads_reconnected", "TikTok Ads was reconnected while this ran. Refresh and try again.");
  }
  return toState(parseAccounts(row.ad_accounts), row.selected_ad_account_id, row.ad_accounts_checked_at);
}

function pickSelected(accounts: SavedAdAccount[], previous: string | null): string | null {
  if (previous && accounts.some((a) => a.advertiser_id === previous)) return previous;
  return accounts.length === 1 ? accounts[0].advertiser_id : null;
}

export async function syncAdAccounts(account: OwnedComposioAccount): Promise<AdAccountsState> {
  const row = await readRow(account.tenant_id);
  const sameLogin = row?.ad_accounts_for === account.connected_account_id;
  const previous = sameLogin ? parseAccounts(row?.ad_accounts) : [];
  const manualIds = previous.filter((a) => a.source === "manual").map((a) => a.advertiser_id);

  let discovered: string[];
  try {
    discovered = await listAdvertiserIds(account);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "tiktok_ads_token_revoked") throw e;
    discovered = previous.filter((a) => a.source === "business_center").map((a) => a.advertiser_id);
  }
  const discoveredSet = new Set(discovered);
  const verified = await verifyAdvertisers(account, [...discovered, ...manualIds]);
  const accounts: SavedAdAccount[] = verified.map((a) => ({
    ...a,
    source: discoveredSet.has(a.advertiser_id) ? "business_center" : "manual",
  }));
  const selected = pickSelected(accounts, sameLogin ? row?.selected_ad_account_id ?? null : null);
  return (await save(account, row?.ad_accounts_checked_at ?? null, accounts, selected)) ?? current(account);
}

export async function ensureAdAccounts(tenantId: string): Promise<AdAccountsState> {
  const row = await readRow(tenantId);
  const team = row?.team_id?.trim();
  if (!team) return NOT_CONNECTED;
  if (row?.ad_accounts_for === team && row.ad_accounts_checked_at) {
    return toState(parseAccounts(row.ad_accounts), row.selected_ad_account_id, row.ad_accounts_checked_at);
  }
  let account: OwnedComposioAccount;
  try {
    account = await tiktokAdsAccount(tenantId);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "tiktok_ads_not_connected") return NOT_CONNECTED;
    throw e;
  }
  return syncAdAccounts(account);
}

export async function readCurrentAdAccounts(tenantId: string): Promise<AdAccountsState> {
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected) return state;
  const account = await tiktokAdsAccount(tenantId);
  const live = await verifyAdvertisers(account, state.accounts.map((a) => a.advertiser_id));
  const saved = new Map(state.accounts.map((a) => [a.advertiser_id, a]));
  return toState(live.map((a) => ({ ...a, source: saved.get(a.advertiser_id)!.source })), state.selected_id, state.checked_at);
}

async function edit(
  tenantId: string,
  change: (state: AdAccountsState) => { accounts: SavedAdAccount[]; selected: string | null },
  verifiedWith?: OwnedComposioAccount,
): Promise<AdAccountsState> {
  const account = await tiktokAdsAccount(tenantId);
  if (verifiedWith && verifiedWith.connected_account_id !== account.connected_account_id) {
    throw new ExpectedToolError("tiktok_ads_reconnected", "TikTok Ads was reconnected while this ran. Refresh and try again.");
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await ensureAdAccounts(tenantId);
    const next = change(state);
    const saved = await save(account, state.checked_at, next.accounts, next.selected);
    if (saved) return saved;
  }
  throw new ExpectedToolError("tiktok_ads_accounts_busy", "Your ad accounts were updating at the same moment. Try again.");
}

export async function selectAdAccount(tenantId: string, advertiserId: string): Promise<AdAccountsState> {
  return edit(tenantId, (state) => {
    if (!state.accounts.some((a) => a.advertiser_id === advertiserId)) {
      throw new ExpectedToolError("tiktok_ads_unknown_account", "That ad account is not one this TikTok login can reach.");
    }
    return { accounts: state.accounts, selected: advertiserId };
  });
}

export function parseAdvertiserInput(input: string): string | null {
  const text = input.trim();
  if (/^\d{6,32}$/.test(text)) return text;
  const m = /[?&#](?:aadvid|advid|advertiser_id)=(\d{6,32})(?:[&#]|$)/i.exec(text);
  return m ? m[1] : null;
}

export async function addManualAdAccount(tenantId: string, input: string): Promise<AdAccountsState> {
  const id = parseAdvertiserInput(input);
  if (!id) {
    throw new ExpectedToolError(
      "tiktok_ads_bad_account_id",
      "That doesn't look like an ad account ID. Paste the whole Ads Manager link, or just the number after aadvid=.",
    );
  }
  const account = await tiktokAdsAccount(tenantId);
  let confirmed: TiktokAdvertiser[] = [];
  try {
    confirmed = await verifyAdvertisers(account, [id]);
  } catch (e) {
    if (e instanceof ExpectedToolError && (e.code === "tiktok_ads_token_revoked" || e.code === "tiktok_ads_rate_limited")) throw e;
  }
  const found = confirmed[0];
  if (!found) {
    throw new ExpectedToolError(
      "tiktok_ads_account_not_reachable",
      `TikTok didn't confirm access to ad account ${id} for the login you connected. Check the ID, or reconnect TikTok Ads with the login that manages this account.`,
    );
  }
  return edit(tenantId, (state) => {
    const existing = state.accounts.find((a) => a.advertiser_id === id);
    const others = state.accounts.filter((a) => a.advertiser_id !== id);
    return { accounts: [...others, { ...found, source: existing?.source ?? "manual" }], selected: id };
  }, account);
}
