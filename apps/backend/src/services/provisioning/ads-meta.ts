
import type { EnsureInput, Provisioner, ProvisionResult } from "./types";
import { CredentialNotConfigured } from "./github-repo";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

type MetaDeps = {
  token?: () => string | null;
  businessId?: () => string | null;
  enabled?: () => boolean;
  graphVersion?: string;
  fetchFn?: FetchLike;
};

function form(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function createMetaAdsProvisioner(deps: MetaDeps = {}): Provisioner {
  const getToken = deps.token ?? (() => process.env.META_PROVISION_TOKEN ?? null);
  const getBusinessId = deps.businessId ?? (() => process.env.META_BUSINESS_ID ?? null);
  const isEnabled = deps.enabled ?? (() => process.env.ADS_PROVISIONING_ENABLED === "1");
  const ver = deps.graphVersion ?? "v25.0";
  const GRAPH = `https://graph.facebook.com/${ver}`;
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("META_PROVISION_TOKEN");
    const businessId = getBusinessId();
    if (!businessId) throw new CredentialNotConfigured("META_BUSINESS_ID");
    if (!isEnabled()) throw new CredentialNotConfigured("ADS_PROVISIONING_ENABLED");

    const res = await fetchFn(`${GRAPH}/${businessId}/adaccount`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        name: `${input.company_name} (Praxis)`.slice(0, 100),
        currency: "USD",
        timezone_id: "1",
        end_advertiser: businessId,
        media_agency: businessId,
        partner: "NONE",
        access_token: token,
      }),
    });
    if (res.status !== 200) {
      throw new Error(`meta adaccount create failed (${res.status}): ${await res.text()}`);
    }
    const acct = (await res.json()) as { id?: string; account_id?: string };
    return {
      external_ref: { meta_ad_account_id: acct.id ?? acct.account_id ?? null },
      vault_keys: {},
    };
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("META_PROVISION_TOKEN");
    const id = String(external_ref.meta_ad_account_id ?? "");
    if (!id) return;
    const res = await fetchFn(`${GRAPH}/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ account_status: "2", access_token: token }),
    });
    if (res.status !== 200) {
      throw new Error(`meta adaccount teardown failed (${res.status}): ${await res.text()}`);
    }
  }

  return { kind: "ads", provider: "meta", ensure, teardown };
}
