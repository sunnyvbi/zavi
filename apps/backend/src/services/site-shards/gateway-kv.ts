
import { domainToASCII } from "node:url";
import { staticHostingConfig } from "@/services/hosting/static-publish";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import type { KvStore } from "@/services/sites/host-record";

export type { KvStore } from "@/services/sites/host-record";

export function bindingKey(hostname: string): string {
  const raw = String(hostname ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253 || !/^[a-z0-9.-]+$/.test(ascii) || !ascii.includes(".")) {
    throw new Error("invalid hostname for a gateway binding");
  }
  return `host:${ascii}`;
}

type CfFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export function cloudflareKv(deps: { env?: Record<string, string | undefined>; fetchFn?: CfFetch } = {}): KvStore {
  const fetchFn: CfFetch = deps.fetchFn ?? ((url, init) => fetch(url, init) as unknown as ReturnType<CfFetch>);
  function cfg() {
    const c = staticHostingConfig(deps.env ?? process.env);
    if (!c.ok) throw new SiteCredentialsMissing(c.missing);
    return c;
  }
  const url = (key: string, qs = "") => {
    const c = cfg();
    return `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/storage/kv/namespaces/${c.kvNamespaceId}/values/${encodeURIComponent(key)}${qs}`;
  };
  return {
    async get(key) {
      const res = await fetchFn(url(key), { method: "GET", headers: { Authorization: `Bearer ${cfg().token}` } });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw new Error(`kv read failed (${res.status})`);
      return res.text();
    },
    async put(key, value, opts) {
      const qs = opts?.expirationTtl ? `?expiration_ttl=${Math.floor(opts.expirationTtl)}` : "";
      const res = await fetchFn(url(key, qs), {
        method: "PUT",
        headers: { Authorization: `Bearer ${cfg().token}`, "Content-Type": "text/plain" },
        body: value,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`kv write failed (${res.status})`);
    },
    async delete(key) {
      const res = await fetchFn(url(key), { method: "DELETE", headers: { Authorization: `Bearer ${cfg().token}` } });
      if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new Error(`kv delete failed (${res.status})`);
    },
  };
}
