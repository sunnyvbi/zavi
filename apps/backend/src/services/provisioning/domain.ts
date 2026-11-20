
import type { EnsureInput, Provisioner, ProvisionResult } from "./types";
import { CredentialNotConfigured } from "./github-repo";
import { tenantScopedSlug } from "./tenant-slug";
import { ensureDnsCname, deleteDnsCname, type CloudflareDnsDeps } from "./cloudflare-dns";
import { envHostSuffix } from "@/services/config/backend-env";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

type DomainDeps = {
  token?: () => string | null;
  baseDomain?: () => string;
  hostSuffix?: () => string;
  fetchFn?: FetchLike;
  cloudflare?: CloudflareDnsDeps;
};

export function onrenderHostFromUrl(url: unknown): string | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  const noProto = raw.replace(/^[a-z]+:\/\//i, "");
  const host = noProto.split("/")[0]?.trim() ?? "";
  return host || null;
}

const RENDER = "https://api.render.com";

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

export const RENDER_MAX_CUSTOM_DOMAIN_CHARS = 64;

const MAX_DNS_LABEL_CHARS = 63;

const TENANT_SUFFIX_CHARS = 9;

export function companyLabelBudget(baseDomain: string, envSuffix = ""): number {
  const labelBudget = Math.min(
    MAX_DNS_LABEL_CHARS,
    RENDER_MAX_CUSTOM_DOMAIN_CHARS - baseDomain.length - 1,
  );
  return Math.max(1, labelBudget - TENANT_SUFFIX_CHARS - envSuffix.length);
}

export function hostSlug(
  company_name: string,
  tenant_id: string,
  baseDomain = "zaviagent.com",
  envSuffix = "",
): string {
  return `${tenantScopedSlug(company_name, tenant_id, companyLabelBudget(baseDomain, envSuffix))}${envSuffix}`;
}

export function createDomainProvisioner(deps: DomainDeps = {}): Provisioner {
  const getToken = deps.token ?? (() => process.env.RENDER_API_KEY ?? null);
  const getBase = deps.baseDomain ?? (() => process.env.PRAXIS_PRODUCT_DOMAIN ?? "zaviagent.com");
  const getSuffix = deps.hostSuffix ?? (() => envHostSuffix());
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const cfDeps = deps.cloudflare ?? {};

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
    const serviceId = String(input.context?.render_service_id ?? "");
    if (!serviceId) {
      throw new Error("domain requires hosting (run the hosting provisioner first; missing context.render_service_id)");
    }
    const base = getBase();
    let envSuffix: string;
    try {
      envSuffix = getSuffix();
    } catch {
      throw new CredentialNotConfigured("SITE_HOSTNAME_SUFFIX");
    }
    const hostname = `${hostSlug(input.company_name, input.tenant_id, base, envSuffix)}.${base}`;

    const list = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains`, { headers: headers(token) });
    let custom_domain_id: string | null = null;
    let foundExisting = false;
    if (list.status === 200) {
      const arr = (await list.json()) as Array<{ customDomain?: { id?: string; name?: string } } | { id?: string; name?: string }>;
      for (const item of arr ?? []) {
        const cd = ("customDomain" in item ? item.customDomain : item) as { id?: string; name?: string } | undefined;
        if (cd?.name === hostname && cd.id) {
          custom_domain_id = cd.id;
          foundExisting = true;
          break;
        }
      }
    } else if (list.status !== 404) {
      throw new Error(`render custom-domain list failed (${list.status}): ${await list.text()}`);
    }

    if (!foundExisting) {
      const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ name: hostname }),
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`render custom-domain create failed (${res.status}): ${await res.text()}`);
      }
      const body = (await res.json()) as { id?: string; customDomain?: { id?: string } };
      custom_domain_id = body.id ?? body.customDomain?.id ?? null;
      if (!custom_domain_id) {
        const relist = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains`, {
          headers: headers(token),
        });
        if (relist.status === 200) {
          const arr = (await relist.json()) as Array<
            { customDomain?: { id?: string; name?: string } } | { id?: string; name?: string }
          >;
          for (const item of arr ?? []) {
            const cd = ("customDomain" in item ? item.customDomain : item) as
              | { id?: string; name?: string }
              | undefined;
            if (cd?.name === hostname && cd.id) {
              custom_domain_id = cd.id;
              break;
            }
          }
        }
        if (!custom_domain_id) {
          throw new Error(
            "render custom-domain created (2xx) but id not resolvable yet — retryable",
          );
        }
      }
    }

    const onrenderHost = onrenderHostFromUrl(input.context?.url);
    let dns_record_id: string | null = null;
    if (!onrenderHost) {
      // eslint-disable-next-line no-console
      console.log(`[domain] no onrender host in context.url — skipping Cloudflare DNS write for ${hostname}`);
    } else {
      const dns = await ensureDnsCname(hostname, onrenderHost, cfDeps);
      dns_record_id = dns.record_id;
    }

    return {
      external_ref: {
        hostname,
        custom_domain_id,
        dns_record_id,
        status: "verifying",
        ...(typeof input.context?.render_service_id === "string"
          ? { render_service_id: input.context.render_service_id }
          : {}),
      },
      vault_keys: {},
    };
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const hostname = String(external_ref.hostname ?? "");
    if (hostname) {
      await deleteDnsCname(hostname, cfDeps, { onlyOnrender: true });
    }
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
    const serviceId = String(external_ref.render_service_id ?? "");
    const cdId = String(external_ref.custom_domain_id ?? "");
    if (!serviceId || !cdId) return;
    const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/custom-domains/${cdId}`, {
      method: "DELETE",
      headers: headers(token),
    });
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new Error(`render custom-domain teardown failed (${res.status}): ${await res.text()}`);
    }
  }

  return { kind: "domain", provider: "thepraxis-subdomain", ensure, teardown };
}
