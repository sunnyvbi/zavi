import type { AdAccount } from "@/services/connectors/core/ads-shapes";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

const OWN_READ_FAILED = () => new ExpectedToolError("linkedin_ads_read_failed", "This workspace's LinkedIn ad accounts could not be read.");

type Rows<T> = { data: T[] | null; error: unknown };
function rowsOf<T>(r: Rows<T>): T[] {
  if (r.error || !Array.isArray(r.data) || r.data.length === 1000) throw OWN_READ_FAILED();
  return r.data;
}

export async function ownLinkedinAccounts(tenantId: string, listed: AdAccount[]): Promise<AdAccount[]> {
  return (await ownLinkedinAccountSet(tenantId, listed)).accounts;
}

export type LinkedinInUse = {
  own: { bindingId: string; providerAccountId: string } | null;
  walletBindingIds: string[];
  bindingIds: Set<string>;
};

export async function linkedinBindingsInUse(tenantId: string): Promise<LinkedinInUse> {
  const db = tenantClient(asTenantId(tenantId));
  const [bindings, selection, statuses] = await Promise.all([
    db.from("ads_account_binding_details").select("id, tenant_id, provider_account_id, funding_source, credential_tenant_id").eq("platform", "linkedin").range(0, 999),
    db.from("ads_account_selections").select("account_binding_id, tenant_id").eq("platform", "linkedin").maybeSingle(),
    db.from("ads_account_binding_status").select("account_binding_id, disabled_at").range(0, 999),
  ]);
  if (selection.error) throw OWN_READ_FAILED();
  const mine = rowsOf(bindings as Rows<{ id: string; tenant_id: string; provider_account_id: string | null; funding_source: string; credential_tenant_id?: string | null }>).filter((b) => b.tenant_id === tenantId);
  const stopped = new Set(
    rowsOf(statuses as Rows<{ account_binding_id: string; disabled_at: string | null }>)
      .filter((s) => s.disabled_at)
      .map((s) => s.account_binding_id),
  );
  const chosen = selection.data as { account_binding_id: string; tenant_id?: string } | null;
  const selected = chosen && (chosen.tenant_id === undefined || chosen.tenant_id === tenantId) ? mine.find((b) => b.id === chosen.account_binding_id) : undefined;
  const own =
    selected && selected.funding_source === "provider" && !!selected.provider_account_id && !stopped.has(selected.id) && (!selected.credential_tenant_id || selected.credential_tenant_id === tenantId)
      ? { bindingId: selected.id, providerAccountId: selected.provider_account_id }
      : null;
  const walletBindingIds = mine.filter((b) => b.funding_source === "wallet").map((b) => b.id);
  return { own, walletBindingIds, bindingIds: new Set([...(own ? [own.bindingId] : []), ...walletBindingIds]) };
}

export async function ownLinkedinAccountSet(tenantId: string, listed: AdAccount[]): Promise<{ accounts: AdAccount[]; inactiveSelected: AdAccount | null }> {
  const db = tenantClient(asTenantId(tenantId));
  const [inUse, claims, bound] = await Promise.all([
    linkedinBindingsInUse(tenantId),
    globalClient()
      .from("ads_provider_accounts")
      .select("provider_account_id, credential_source, credential_tenant_id")
      .eq("platform", "linkedin")
      .in("provider_account_id", listed.map((a) => a.id))
      .range(0, 999),
    db
      .from("ads_campaign_binding_details")
      .select("account_binding_id, tenant_id")
      .eq("platform", "linkedin")
      .eq("funding_source", "provider")
      .range(0, 999),
  ]);
  const elsewhere = new Set(
    rowsOf(claims as Rows<{ provider_account_id: string | null; credential_source: string; credential_tenant_id: string | null }>)
      .filter((c) => c.credential_source !== "tenant_connector" || c.credential_tenant_id !== tenantId)
      .flatMap((c) => (c.provider_account_id ? [c.provider_account_id] : [])),
  );
  const selected = inUse.own?.providerAccountId;
  const withCampaigns = rowsOf(bound as Rows<{ account_binding_id: string; tenant_id: string }>).some((c) => c.tenant_id === tenantId && c.account_binding_id === inUse.own?.bindingId);
  const accounts = listed.filter((a) => a.id === selected && !elsewhere.has(a.id) && (withCampaigns || a.status === "ACTIVE"));
  const inactiveSelected = listed.find((a) => a.id === selected && !elsewhere.has(a.id) && !accounts.includes(a)) ?? null;
  return { accounts, inactiveSelected };
}

export type LinkedinAccountHolders = { elsewhere: Set<string>; managed: Set<string> };

export async function readLinkedinAccountHolders(tenantId: string, ids: string[]): Promise<LinkedinAccountHolders> {
  if (!ids.length) return { elsewhere: new Set(), managed: new Set() };
  const claims = rowsOf(
    (await globalClient()
      .from("ads_provider_accounts")
      .select("provider_account_id, credential_source, credential_tenant_id, claim_released_at")
      .eq("platform", "linkedin")
      .in("provider_account_id", ids)
      .range(0, 999)) as Rows<{ provider_account_id: string | null; credential_source: string; credential_tenant_id: string | null; claim_released_at: string | null }>,
  );
  const held = (keep: (c: (typeof claims)[number]) => boolean) => new Set(claims.filter(keep).flatMap((c) => (c.provider_account_id ? [c.provider_account_id] : [])));
  return {
    elsewhere: held((c) => c.credential_source === "tenant_connector" && c.credential_tenant_id !== tenantId && !c.claim_released_at),
    managed: held((c) => c.credential_source !== "tenant_connector"),
  };
}

export async function linkedinAccountHolders(tenantId: string, ids: string[]): Promise<LinkedinAccountHolders> {
  try {
    return await readLinkedinAccountHolders(tenantId, ids);
  } catch {
    return { elsewhere: new Set(), managed: new Set() };
  }
}

export async function linkedinOwnAccountChoices<A extends { id: string }>(tenantId: string, accounts: A[]): Promise<Array<A & { held_elsewhere?: true }>> {
  const { elsewhere, managed } = await linkedinAccountHolders(tenantId, accounts.map((a) => a.id));
  return accounts.filter((a) => !managed.has(a.id)).map((a) => (elsewhere.has(a.id) ? { ...a, held_elsewhere: true as const } : a));
}

export async function linkedinAccountStoppable(tenantId: string, accountId: string): Promise<boolean> {
  if (await linkedinAccountInUse(tenantId, accountId)) return true;
  const db = tenantClient(asTenantId(tenantId));
  const [bindings, bound] = await Promise.all([
    db.from("ads_account_binding_details").select("id, tenant_id, provider_account_id, funding_source, credential_tenant_id").eq("platform", "linkedin").eq("provider_account_id", accountId).range(0, 999),
    db.from("ads_campaign_binding_details").select("account_binding_id, tenant_id").eq("platform", "linkedin").eq("funding_source", "provider").range(0, 999),
  ]);
  const own = rowsOf(bindings as Rows<{ id: string; tenant_id: string; provider_account_id: string | null; funding_source: string; credential_tenant_id?: string | null }>)
    .filter((b) => b.tenant_id === tenantId && b.funding_source === "provider" && (!b.credential_tenant_id || b.credential_tenant_id === tenantId))
    .map((b) => b.id);
  if (!own.length) return false;
  return rowsOf(bound as Rows<{ account_binding_id: string; tenant_id: string }>).some((c) => c.tenant_id === tenantId && own.includes(c.account_binding_id));
}

export async function linkedinAccountInUse(tenantId: string, accountId: string): Promise<boolean> {
  const { accounts } = await ownLinkedinAccountSet(tenantId, [{ id: accountId, name: accountId, currency: null, status: "ACTIVE" }]);
  return accounts.some((a) => a.id === accountId);
}
