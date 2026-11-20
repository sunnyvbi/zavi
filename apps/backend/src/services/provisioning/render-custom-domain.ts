
import { CredentialNotConfigured } from "./github-repo";
import { onrenderHostFromUrl } from "./domain";
import { BUILTIN_HOST_IN_USE } from "./cloudflare-dns";

const RENDER = "https://api.render.com";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type RenderCustomDomainDeps = {
  token?: () => string | null;
  fetchFn?: FetchLike;
};

export type RenderVerificationStatus = "verified" | "unverified";

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

function resolve(deps: RenderCustomDomainDeps): { token: string; fetchFn: FetchLike } {
  const token = (deps.token ?? (() => process.env.RENDER_API_KEY ?? null))();
  if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  return { token, fetchFn };
}

type CustomDomainRow = { id: string; name: string; verificationStatus: RenderVerificationStatus | null };

function parseItem(item: unknown): CustomDomainRow | null {
  const obj = item as { customDomain?: Record<string, unknown> } & Record<string, unknown>;
  const cd = (obj?.customDomain ?? obj) as Record<string, unknown> | undefined;
  const id = typeof cd?.id === "string" ? cd.id : null;
  const name = typeof cd?.name === "string" ? cd.name : null;
  if (!id || !name) return null;
  const vs = cd?.verificationStatus;
  return {
    id,
    name: name.toLowerCase(),
    verificationStatus: vs === "verified" || vs === "unverified" ? vs : null,
  };
}

async function listCustomDomains(
  serviceId: string,
  token: string,
  fetchFn: FetchLike,
): Promise<CustomDomainRow[]> {
  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains?limit=100`, { headers: headers(token) });
  if (res.status === 404) return [];
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`render custom-domain list failed (${res.status}): ${await res.text()}`);
  }
  const arr = (await res.json()) as unknown[];
  return (arr ?? []).map(parseItem).filter((r): r is CustomDomainRow => r !== null);
}

export async function attachRenderCustomDomain(
  serviceId: string,
  hostname: string,
  deps: RenderCustomDomainDeps = {},
): Promise<{ custom_domain_id: string; already: boolean }> {
  const { token, fetchFn } = resolve(deps);
  const norm = hostname.toLowerCase();

  const existing = (await listCustomDomains(serviceId, token, fetchFn)).find((r) => r.name === norm);
  if (existing) return { custom_domain_id: existing.id, already: true };

  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: norm }),
  });

  if (res.status !== 200 && res.status !== 201 && res.status !== 409 && res.status !== 422) {
    throw new Error(`render custom-domain create failed (${res.status}): ${await res.text()}`);
  }
  if (res.status === 200 || res.status === 201) {
    const body = (await res.json().catch(() => ({}))) as { id?: string; customDomain?: { id?: string } };
    const id = body.id ?? body.customDomain?.id ?? null;
    if (id) return { custom_domain_id: id, already: false };
  }

  const relisted = (await listCustomDomains(serviceId, token, fetchFn)).find((r) => r.name === norm);
  if (relisted) return { custom_domain_id: relisted.id, already: res.status === 409 || res.status === 422 };

  if (res.status === 409 || res.status === 422) {
    throw new Error(BUILTIN_HOST_IN_USE);
  }
  throw new Error("render custom-domain created but id not resolvable yet — retryable");
}

export async function getRenderCustomDomainStatus(
  serviceId: string,
  idOrHostname: string,
  deps: RenderCustomDomainDeps = {},
): Promise<RenderVerificationStatus | null> {
  const { token, fetchFn } = resolve(deps);
  const rows = await listCustomDomains(serviceId, token, fetchFn);
  const needle = idOrHostname.toLowerCase();
  const row = rows.find((r) => r.id === idOrHostname || r.name === needle);
  return row?.verificationStatus ?? null;
}

export async function verifyRenderCustomDomain(
  serviceId: string,
  customDomainId: string,
  deps: RenderCustomDomainDeps = {},
): Promise<void> {
  const { token, fetchFn } = resolve(deps);
  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains/${customDomainId}/verify`, {
    method: "POST",
    headers: headers(token),
  });
  if (res.status === 404) return;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`render custom-domain verify failed (${res.status}): ${await res.text()}`);
  }
}

export async function detachRenderCustomDomain(
  serviceId: string,
  customDomainId: string,
  deps: RenderCustomDomainDeps = {},
): Promise<void> {
  const { token, fetchFn } = resolve(deps);
  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains/${customDomainId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
    throw new Error(`render custom-domain detach failed (${res.status}): ${await res.text()}`);
  }
}

export const RENDER_APEX_IP = "216.24.57.1";

export type CustomDomainDnsRecord = { type: string; host: string; value: string; note?: string };

export function customDomainDnsRecords(
  hostname: string,
  onrenderUrl: string | null | undefined,
  domainType: "subdomain" | "apex" = "subdomain",
): CustomDomainDnsRecord[] {
  const onrenderHost = onrenderHostFromUrl(onrenderUrl);
  if (domainType !== "apex") {
    return [{ type: "CNAME", host: hostname, value: onrenderHost ?? "" }];
  }
  const records: CustomDomainDnsRecord[] = [
    {
      type: "A",
      host: "@",
      value: RENDER_APEX_IP,
      note: "Works at every registrar. Use “@” (or leave the host blank) for the root domain.",
    },
  ];
  if (onrenderHost) {
    records.push({
      type: "ALIAS",
      host: "@",
      value: onrenderHost,
      note: "Better, if your DNS provider supports ALIAS/ANAME — or a CNAME at the root, like Cloudflare.",
    });
  }
  return records;
}
