import { z } from "zod";
import { asTenantId, globalClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  bindCampaign,
  getAccountBinding,
  legacyChatgptAccount,
  selectAccountBinding,
  type AccountBinding,
} from "./bindings";
import { requireSharedWalletConsent } from "./consent";

export const adsPlatform = z.enum(["chatgpt", "linkedin"]);
export type AdsPlatform = z.infer<typeof adsPlatform>;
const db = (tenant: string) => tenantClient(asTenantId(tenant));
function fail(): never {
  throw new ExpectedToolError(
    "ads_accounts_unavailable",
    "Ad accounts could not be verified. Refresh and try again.",
  );
}
export const LINKEDIN_ACCOUNT_HELD_AFTER_DISCONNECT =
  "This ad account is still tied to campaigns in another Zavi workspace, even though that workspace has disconnected LinkedIn. Contact Zavi support to move it to this workspace, or choose a different account.";
export const LINKEDIN_MANAGED_NOT_OWN =
  "This is Zavi's managed ad account, so it cannot be used as your own account. Use it under Use a Zavi account instead.";
export const LINKEDIN_WALLET_SWITCHED_OFF =
  "Zavi's own LinkedIn ad account is not switched on yet, so it cannot be used for new campaigns. Connect your own LinkedIn ad account instead.";
export const LINKEDIN_WALLET_NOT_READY =
  "Zavi's LinkedIn ad account is not ready for this workspace, so it cannot be used for new campaigns. Choose another account, or connect your own LinkedIn ad account.";
export async function linkedinWalletSwitchedOn() {
  const [{ managedLinkedinEnabled }, { fundingEnabled }] = await Promise.all([
    import("./managed-linkedin"),
    import("./wallet"),
  ]);
  return managedLinkedinEnabled() && fundingEnabled();
}
async function usableLinkedinGrants(accountIds: string[]) {
  if (!accountIds.length) return new Set<string>();
  const { data, error } = await globalClient()
    .from("ads_provider_accounts")
    .select("id,credential_source,verified_at,currency")
    .in("id", accountIds)
    .range(0, 999);
  if (error || !Array.isArray(data)) return fail();
  return new Set(
    z
      .array(
        z.object({
          id: z.string(),
          credential_source: z.string(),
          verified_at: z.string().nullable(),
          currency: z.string().nullable(),
        }),
      )
      .parse(data)
      .filter((a) => a.credential_source === "platform" && !!a.verified_at && a.currency === "USD")
      .map((a) => a.id),
  );
}
async function assertLinkedinWalletUsable(tenantId: string, accountId: string) {
  if (!(await linkedinWalletSwitchedOn()))
    throw new ExpectedToolError("ads_managed_unavailable", LINKEDIN_WALLET_SWITCHED_OFF);
  const grant = await db(tenantId)
    .from("ads_managed_account_choices")
    .select("account_id")
    .eq("platform", "linkedin")
    .eq("account_id", accountId)
    .is("disabled_at", null)
    .maybeSingle();
  if (grant.error) return fail();
  if (!grant.data || !(await usableLinkedinGrants([accountId])).has(accountId))
    throw new ExpectedToolError("ads_managed_unavailable", LINKEDIN_WALLET_NOT_READY);
}
export async function accountChoices(tenantId: string, platform: AdsPlatform) {
  const [bindings, selected, disabled] = await Promise.all([
    db(tenantId)
      .from("ads_account_binding_details")
      .select("id,account_id,platform,provider_account_id,funding_source,currency,credential_tenant_id")
      .eq("platform", platform)
      .range(0, 999),
    db(tenantId)
      .from("ads_account_selections")
      .select("account_binding_id")
      .eq("platform", platform)
      .maybeSingle(),
    db(tenantId)
      .from("ads_account_binding_status")
      .select("account_binding_id,disabled_at")
      .range(0, 999),
  ]);
  if (
    [bindings, selected, disabled].some((r) => r.error) ||
    bindings.data?.length === 1000 ||
    disabled.data?.length === 1000
  )
    return fail();
  const managed = await db(tenantId)
    .from("ads_managed_account_choices")
    .select("account_id,label,platform")
    .eq("platform", platform)
    .is("disabled_at", null)
    .range(0, 999);
  if (managed.error || managed.data?.length === 1000) return fail();
  const statuses = z
    .array(
      z.object({
        account_binding_id: z.string(),
        disabled_at: z.string().nullable(),
      }),
    )
    .parse(disabled.data);
  const accounts = z
    .array(
      z.object({
        id: z.string(),
        account_id: z.string().nullable().optional(),
        platform: adsPlatform,
        provider_account_id: z.string().nullable(),
        funding_source: z.enum(["wallet", "provider"]),
        currency: z.string().nullable(),
        credential_tenant_id: z.string().nullable().optional(),
      }),
    )
    .parse(bindings.data);
  const selection = z
    .object({ account_binding_id: z.string() })
    .nullable()
    .parse(selected.data);
  const disabledIds = new Set(
    statuses.filter((x) => x.disabled_at).map((x) => x.account_binding_id),
  );
  const grants = (managed.data ?? []) as Array<{ account_id: string; label: string; platform: string }>;
  const usable =
    platform === "linkedin"
      ? (await linkedinWalletSwitchedOn())
        ? await usableLinkedinGrants(grants.map((g) => g.account_id))
        : new Set<string>()
      : null;
  const offered = usable
    ? accounts.filter((b) => b.funding_source !== "wallet" || (!!b.account_id && usable.has(b.account_id)))
    : accounts;
  const selectedId = selection?.account_binding_id ?? null;
  return {
    accounts: offered.map(({ credential_tenant_id, account_id, ...b }) => ({
      ...b,
      ...(b.funding_source === "wallet" && account_id ? { account_id } : {}),
      disabled: disabledIds.has(b.id),
      ...(credential_tenant_id && credential_tenant_id !== tenantId ? { owned_elsewhere: true } : {}),
    })),
    managed: usable ? grants.filter((g) => usable.has(g.account_id)) : grants,
    selected_id: selectedId && (offered.some((b) => b.id === selectedId) || !accounts.some((b) => b.id === selectedId)) ? selectedId : null,
  };
}
export async function verifyBoundAccount(
  tenantId: string,
  binding: AccountBinding,
  write = false,
  refuseBillingHold = write,
) {
  if (binding.platform === "linkedin")
    return (await import("./adapters/linkedin-account")).resolveLinkedinAccount(
      tenantId,
      binding,
      write,
      refuseBillingHold,
    );
  if (binding.platform === "chatgpt")
    return (
      await import("@/services/connectors/chatgpt-ads/account-binding")
    ).resolveChatgptAccount(tenantId, binding);
  return fail();
}
export async function chooseAccount(
  tenantId: string,
  platform: AdsPlatform,
  bindingId: string,
) {
  const binding = await getAccountBinding(tenantId, bindingId);
  if (binding.platform !== platform) return fail();
  const status = await db(tenantId)
    .from("ads_account_binding_status")
    .select("disabled_at")
    .eq("account_binding_id", binding.id)
    .maybeSingle();
  if (status.error) return fail();
  if ((status.data as { disabled_at: string | null } | null)?.disabled_at)
    throw new ExpectedToolError(
      "ads_account_disabled",
      "This account is stopped for new campaigns. Choose Use this account again to turn it back on, or pick another account.",
    );
  if (binding.funding_source === "wallet" && platform === "linkedin")
    await assertLinkedinWalletUsable(tenantId, binding.account_id);
  if (binding.funding_source === "wallet" && platform !== "chatgpt")
    await requireSharedWalletConsent(tenantId);
  await verifyBoundAccount(tenantId, binding, true, false);
  await selectAccountBinding(tenantId, bindingId);
}
export async function connectManagedAccount(
  tenantId: string,
  platform: AdsPlatform,
  accountId?: string,
) {
  if (platform === "chatgpt" && !accountId) {
    const b = await legacyChatgptAccount(tenantId);
    await chooseAccount(tenantId, platform, b.id);
    return b.id;
  }
  if (!accountId) return fail();
  if (platform === "linkedin") await assertLinkedinWalletUsable(tenantId, accountId);
  await requireSharedWalletConsent(tenantId);
  const { data, error } = await tenantRpc(
    asTenantId(tenantId),
    "ads_use_managed_account",
    { p_account_id: accountId },
  );
  if (error || typeof data !== "string") return fail();
  await chooseAccount(tenantId, platform, data);
  return data;
}
export async function customerAccountChoices(
  tenantId: string,
  platform: AdsPlatform,
  refresh = false,
) {
  if (platform === "linkedin") {
    const [{ linkedinOpenAccountList, loginManages }, { linkedinOwnAccountChoices }] = await Promise.all([
      import("@/services/connectors/linkedin-ads/account-list-cache"),
      import("@/services/connectors/linkedin-ads/own-accounts"),
    ]);
    const list = await linkedinOpenAccountList(tenantId, refresh);
    const [accounts, manages] = await Promise.all([linkedinOwnAccountChoices(tenantId, list.accounts), loginManages(tenantId)]);
    return { ...list, accounts: accounts.map((a) => (manages && !manages.has(a.id) ? { ...a, view_only: true as const } : a)) };
  }
  throw new ExpectedToolError(
    "ads_connection_required",
    "Connect a ChatGPT Ads API key to use your own account.",
  );
}
export async function connectChatgptCustomerKey(tenantId: string, key: string) {
  const { chatgptAdsGet } =
    await import("@/services/connectors/chatgpt-ads/http");
  const account = z
    .object({
      id: z.string().min(1).max(200),
      currency_code: z.string().regex(/^[A-Z]{3}$/),
    })
    .parse(await chatgptAdsGet(key, "/ad_account"));
  const saved = await tenantRpc(
    asTenantId(tenantId),
    "ads_save_chatgpt_customer_account",
    {
      p_provider_account_id: account.id,
      p_currency: account.currency_code,
      p_api_key: key,
    },
  );
  if (saved.error || typeof saved.data !== "string") return fail();
  await chooseAccount(tenantId, "chatgpt", saved.data);
  return saved.data;
}
export async function connectCustomerAccount(
  tenantId: string,
  platform: AdsPlatform,
  accountId: string,
  select = true,
) {
  let currency: string;
  let credential: string;
  if (platform === "linkedin") {
    const { withLinkedInAdsToken } =
      await import("@/services/connectors/linkedin-ads/client");
    const { readLinkedinAccount, assertLinkedinCampaignRole } = await import("./adapters/linkedin-account");
    currency = (
      await withLinkedInAdsToken(tenantId, async (token) => {
        const account = await readLinkedinAccount(token, accountId);
        await assertLinkedinCampaignRole(token, account.id);
        return account;
      })
    ).currency;
    credential = "linkedin_ads.access_token";
  } else
    throw new ExpectedToolError(
      "ads_connection_required",
      "Connect a ChatGPT Ads API key first.",
    );
  const { data, error } = await tenantRpc(
    asTenantId(tenantId),
    "ads_register_customer_account",
    {
      p_platform: platform,
      p_provider_account_id: accountId,
      p_currency: currency,
      p_credential_ref: credential,
    },
  );
  if (error?.message === "account ownership conflict" && platform === "linkedin") {
    const { linkedinAccountHolders } = await import("@/services/connectors/linkedin-ads/own-accounts");
    if ((await linkedinAccountHolders(tenantId, [accountId])).managed.has(accountId))
      throw new ExpectedToolError("ads_account_owned_elsewhere", LINKEDIN_MANAGED_NOT_OWN);
  }
  if (error?.message === "account ownership conflict")
    throw new ExpectedToolError(
      "ads_account_owned_elsewhere",
      "This ad account is already connected to another Zavi workspace. Choose a different account, or disconnect it from the other workspace first.",
    );
  if (error?.message === "account claim held after disconnect")
    throw new ExpectedToolError("ads_account_owned_elsewhere", LINKEDIN_ACCOUNT_HELD_AFTER_DISCONNECT);
  if (error || typeof data !== "string") return fail();
  if (select) await chooseAccount(tenantId, platform, data);
  return data;
}

export async function enableWalletAccount(
  tenantId: string,
  platform: AdsPlatform,
  bindingId: string,
): Promise<boolean> {
  const unavailable = (): never => {
    throw new ExpectedToolError(
      "ads_enable_unavailable",
      "Zavi could not turn this ad account back on just now. Nothing was changed. Try again in a minute, or pick another account.",
    );
  };
  const found = await db(tenantId)
    .from("ads_account_binding_details")
    .select("id,tenant_id,account_id,platform,funding_source,credential_source,legacy_key")
    .eq("id", bindingId)
    .maybeSingle();
  if (found.error) return unavailable();
  const binding = found.data as Pick<
    AccountBinding,
    "id" | "tenant_id" | "account_id" | "platform" | "funding_source" | "credential_source" | "legacy_key"
  > | null;
  if (
    !binding ||
    binding.tenant_id !== tenantId ||
    binding.platform !== platform ||
    binding.funding_source !== "wallet" ||
    binding.credential_source !== "platform" ||
    binding.legacy_key !== null
  )
    return false;
  const grant = await db(tenantId)
    .from("ads_managed_account_grants")
    .select("account_id")
    .eq("account_id", binding.account_id)
    .is("disabled_at", null)
    .maybeSingle();
  if (grant.error) return unavailable();
  if (!grant.data) return false;
  const updated = await db(tenantId)
    .from("ads_account_binding_status")
    .update({ disabled_at: null })
    .eq("account_binding_id", binding.id)
    .select("account_binding_id");
  if (updated.error || !Array.isArray(updated.data)) return unavailable();
  return updated.data.length === 1;
}

export async function assertAccountAvailableForNewCampaign(
  tenantId: string,
  binding: AccountBinding,
) {
  if (binding.tenant_id !== tenantId) return fail();
  const status = await db(tenantId)
    .from("ads_account_binding_status")
    .select("disabled_at")
    .eq("account_binding_id", binding.id)
    .maybeSingle();
  if (
    status.error ||
    (status.data as { disabled_at: string | null } | null)?.disabled_at
  )
    return fail();
  if (
    binding.funding_source === "wallet" &&
    binding.legacy_key !== "chatgpt_platform"
  ) {
    await requireSharedWalletConsent(tenantId);
    if (binding.platform === "linkedin") return assertLinkedinWalletUsable(tenantId, binding.account_id);
    const grant = await db(tenantId)
      .from("ads_managed_account_grants")
      .select("account_id")
      .eq("account_id", binding.account_id)
      .is("disabled_at", null)
      .maybeSingle();
    if (grant.error || !grant.data) return fail();
  }
}
export async function importCustomerCampaign(
  tenantId: string,
  bindingId: string,
  campaignId: string,
  platform?: AdsPlatform,
) {
  const binding = await getAccountBinding(tenantId, bindingId);
  if (
    binding.funding_source !== "provider" ||
    (platform && binding.platform !== platform)
  )
    return fail();
  if (binding.platform === "linkedin") {
    const { resolveLinkedinAccount } =
      await import("./adapters/linkedin-account");
    const { linkedinAdsGet } =
      await import("@/services/connectors/linkedin-ads/http");
    const { token, account } = await resolveLinkedinAccount(tenantId, binding);
    z.string()
      .regex(/^\d{1,20}$/)
      .parse(campaignId);
    const c = await linkedinAdsGet<{ id: number; account: string }>(
      token,
      `adAccounts/${account.id}/adCampaigns/${campaignId}`,
    );
    if (
      String(c.id) !== campaignId ||
      c.account !== `urn:li:sponsoredAccount:${account.id}`
    )
      return fail();
  } else if (binding.platform === "chatgpt") {
    z.string()
      .regex(/^[a-zA-Z0-9_-]{1,200}$/)
      .parse(campaignId);
    const { resolveChatgptAccount } =
      await import("@/services/connectors/chatgpt-ads/account-binding");
    const { chatgptAdsGet } =
      await import("@/services/connectors/chatgpt-ads/http");
    const { key } = await resolveChatgptAccount(tenantId, binding);
    const c = await chatgptAdsGet<{ id: string }>(
      key,
      `/campaigns/${encodeURIComponent(campaignId)}`,
    );
    if (c.id !== campaignId) return fail();
  } else return fail();
  return bindCampaign(tenantId, binding, campaignId);
}
