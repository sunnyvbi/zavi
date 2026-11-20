
import { composioProxy, type OwnedComposioAccount } from "./api";
import { resolveOwnedComposioAccount } from "./account";

export type TenantGoogleAuth = {
  access_token: string;
  account_email: string | null;
  fetchFn: typeof fetch;
};

export function composioProxyFetch(account: OwnedComposioAccount): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = await composioProxy({ account, method: "GET", endpoint: url });
    const body: unknown = r.json;
    const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
    return new Response(text, { status: r.status >= 200 && r.status <= 599 ? r.status : 502 });
  }) as typeof fetch;
}

export async function getTenantGoogleAuth(tenant_id: string): Promise<TenantGoogleAuth | null> {
  const account = await resolveOwnedComposioAccount(tenant_id, "googledrive");
  if (!account) return null;
  return { access_token: "", account_email: null, fetchFn: composioProxyFetch(account) };
}
