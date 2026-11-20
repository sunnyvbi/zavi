import { createHash } from "node:crypto";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { LINKEDIN_ADS_SLUG } from "./constants";
import { linkedinAdsToken, listLinkedInAdAccountsRaw, withLinkedInAdsToken } from "./client";
import {
  linkedinAccountLists,
  linkedinAccountListsInFlight,
  loadLinkedInAdsStore,
  saveLinkedInAdsStore,
  type LinkedInAccountListEntry,
} from "./read-cache";

export const ACCOUNT_LIST_TTL_MS = 24 * 3600_000;
export const ACCOUNT_LIST_REFRESH_MS = 5 * 60_000;
export const EMPTY_ACCOUNT_LIST_TTL_MS = 5 * 60_000;
export const EMPTY_ACCOUNT_LIST_REFRESH_MS = 30_000;
const MAX_LISTS = 1000;

export type LinkedInAccountList = {
  accounts: LinkedInAccountListEntry["accounts"];
  fetched_at: string;
  just_refreshed: boolean;
};

const CLOSED_ACCOUNT_STATUSES = new Set(["CANCELED", "PENDING_DELETION", "REMOVED"]);
export const linkedinAccountOpen = (status: string | null) => !CLOSED_ACCOUNT_STATUSES.has(status ?? "");

const callerOf = (token: string) => createHash("sha256").update(token).digest("hex");

function served(entry: LinkedInAccountListEntry, justRefreshed: boolean): LinkedInAccountList {
  return { accounts: entry.accounts.map((a) => ({ ...a })), fetched_at: new Date(entry.fetched_at).toISOString(), just_refreshed: justRefreshed };
}

export async function linkedinAccountList(tenantId: string, refresh = false): Promise<LinkedInAccountList> {
  loadLinkedInAdsStore();
  const key = `${tenantId}:linkedin`;
  const caller = callerOf(await linkedinAdsToken(tenantId));
  const hit = linkedinAccountLists.get(key);
  if (hit && hit.caller === caller) {
    const age = Date.now() - hit.fetched_at;
    const usable = hit.accounts.some((a) => linkedinAccountOpen(a.status));
    const limit = usable ? (refresh ? ACCOUNT_LIST_REFRESH_MS : ACCOUNT_LIST_TTL_MS) : refresh ? EMPTY_ACCOUNT_LIST_REFRESH_MS : EMPTY_ACCOUNT_LIST_TTL_MS;
    if (age >= 0 && age < limit) return served(hit, false);
  }
  const flightKey = `${key}:${caller}`;
  let flight = linkedinAccountListsInFlight.get(flightKey);
  if (!flight) {
    flight = withLinkedInAdsToken(tenantId, async (token) => ({
      caller: callerOf(token),
      accounts: await listLinkedInAdAccountsRaw(token, "join"),
      fetched_at: Date.now(),
    })).then((entry) => {
      const current = linkedinAccountLists.get(key);
      if (!current || current.fetched_at <= entry.fetched_at) {
        linkedinAccountLists.delete(key);
        linkedinAccountLists.set(key, entry);
        if (linkedinAccountLists.size > MAX_LISTS) linkedinAccountLists.delete(linkedinAccountLists.keys().next().value!);
        saveLinkedInAdsStore();
      }
      return entry;
    });
    const mine = flight;
    linkedinAccountListsInFlight.set(flightKey, mine);
    void mine.then(
      () => { if (linkedinAccountListsInFlight.get(flightKey) === mine) linkedinAccountListsInFlight.delete(flightKey); },
      () => { if (linkedinAccountListsInFlight.get(flightKey) === mine) linkedinAccountListsInFlight.delete(flightKey); },
    );
  }
  return served(await flight, refresh);
}

export async function linkedinOpenAccountList(tenantId: string, refresh = false): Promise<LinkedInAccountList> {
  const list = await linkedinAccountList(tenantId, refresh);
  return { ...list, accounts: list.accounts.filter((a) => linkedinAccountOpen(a.status)) };
}

type LoginAccounts = { open: Set<string>; closed: Set<string>; held: Set<string> };

async function accountsOnLogin(tenantId: string, refresh: boolean): Promise<LoginAccounts | null> {
  try {
    const { accounts } = await linkedinAccountList(tenantId, refresh);
    return {
      open: new Set(accounts.filter((a) => linkedinAccountOpen(a.status)).map((a) => a.id)),
      closed: new Set(accounts.filter((a) => !linkedinAccountOpen(a.status)).map((a) => a.id)),
      held: new Set(accounts.filter((a) => a.billing_hold).map((a) => a.id)),
    };
  } catch (e) {
    return e instanceof ExpectedToolError && e.code === "linkedin_ads_not_connected" ? { open: new Set(), closed: new Set(), held: new Set() } : null;
  }
}

export async function loginManages(tenantId: string): Promise<Set<string> | null> {
  try {
    const { linkedinCachedManagedAccountIds } = await import("@/services/ads-wallet/adapters/linkedin-account");
    return await linkedinCachedManagedAccountIds(await linkedinAdsToken(tenantId));
  } catch {
    return null;
  }
}

export async function linkedinConnectionStamp(tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("connector_metadata")
      .select("team_id, connected_at")
      .eq("slug", LINKEDIN_ADS_SLUG)
      .maybeSingle();
    if (error) return null;
    const row = data as { team_id?: string | null; connected_at?: string | null } | null;
    return row ? callerOf(`${row.team_id ?? ""}@${row.connected_at ?? ""}`).slice(0, 16) : "none";
  } catch {
    return null;
  }
}

export async function linkedinChoicesForLogin<A extends { id: string; provider_account_id: string | null; funding_source: "wallet" | "provider" }, C extends { accounts: A[]; selected_id: string | null }>(tenantId: string, choices: C): Promise<C & { unseen_selected_id?: string | null; unseen_selected_closed?: boolean }> {
  const own = choices.accounts.filter((a) => a.funding_source === "provider" && a.provider_account_id);
  let seen = own.length ? await accountsOnLogin(tenantId, false) : null;
  if (seen && own.some((a) => !seen!.open.has(a.provider_account_id!))) seen = (await accountsOnLogin(tenantId, true)) ?? seen;
  if (!seen) return choices;
  const login = seen;
  const unseen = new Map(own.filter((a) => !login.open.has(a.provider_account_id!)).map((a) => [a.id, a.provider_account_id!]));
  const lost = !!choices.selected_id && unseen.has(choices.selected_id);
  const manages = await loginManages(tenantId);
  const flags = (a: A) =>
    a.funding_source !== "provider" || !a.provider_account_id || unseen.has(a.id)
      ? {}
      : {
          ...(login.held.has(a.provider_account_id) ? { billing_hold: true as const } : {}),
          ...(manages && !manages.has(a.provider_account_id) ? { view_only: true as const } : {}),
        };
  return {
    ...choices,
    accounts: choices.accounts.map((a) => (unseen.has(a.id) ? { ...a, not_on_login: true } : { ...a, ...flags(a) })),
    selected_id: lost ? null : choices.selected_id,
    unseen_selected_id: lost ? choices.selected_id : null,
    unseen_selected_closed: lost && login.closed.has(unseen.get(choices.selected_id!)!),
  };
}
