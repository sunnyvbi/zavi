
import { cfCall, findDns, findRoute, staticHostingConfig, STATIC_PLACEHOLDER_IP, type StaticFetch } from "@/services/hosting/static-publish";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import { GATEWAY_WORKER_ENV } from "./gateway-route";

const CF = "https://api.cloudflare.com/client/v4";
export const PREVIEW_DOMAIN_ENV = "SITE_PREVIEW_DOMAIN";
export const PREVIEW_ZONE_ENV = "SITE_PREVIEW_ZONE_ID";
export const PREVIEW_LABEL_RE = /^[a-z2-7]{26}$/;
const DOMAIN_RE = /^(?=.{4,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function previewDomain(env: Record<string, string | undefined> = process.env): string | null {
  const d = (env[PREVIEW_DOMAIN_ENV] ?? "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

export function isPreviewHost(host: string, domain: string | null): boolean {
  if (!domain) return false;
  const h = String(host ?? "").toLowerCase();
  if (!h.endsWith(`.${domain}`)) return false;
  return PREVIEW_LABEL_RE.test(h.slice(0, -(domain.length + 1)));
}

export const previewKvKey = (host: string) => `preview:${host}`;

export class PreviewRoutingUnavailable extends Error {
  constructor(reason: string) {
    super(`preview routing unavailable: ${reason}`);
    this.name = "PreviewRoutingUnavailable";
  }
}

export type PreviewRoutingDeps = { env?: Record<string, string | undefined>; fetchFn?: StaticFetch };

export async function ensurePreviewRoutingOnce(deps: PreviewRoutingDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const fetchFn: StaticFetch = deps.fetchFn ?? ((globalThis as unknown as { fetch: StaticFetch }).fetch);
  const domain = previewDomain(env);
  const zoneId = (env[PREVIEW_ZONE_ENV] ?? "").trim();
  const gateway = (env[GATEWAY_WORKER_ENV] ?? "").trim();
  const cfg = staticHostingConfig(env);
  const missing = [
    ...(cfg.ok ? [] : cfg.missing),
    ...(domain ? [] : [PREVIEW_DOMAIN_ENV]),
    ...(zoneId ? [] : [PREVIEW_ZONE_ENV]),
    ...(gateway ? [] : [GATEWAY_WORKER_ENV]),
  ];
  if (!cfg.ok || missing.length || !domain) throw new SiteCredentialsMissing(missing);
  const want: Array<[string, string]> = [
    [`*.${domain}/*`, cfg.workerName],
    [`*.${domain}/api/*`, gateway],
  ];
  for (const [pattern, script] of want) {
    const route = await findRoute(fetchFn, cfg.token, zoneId, pattern);
    if (route) {
      if (route.script !== script) throw new PreviewRoutingUnavailable(`route ${pattern} belongs to another worker`);
      continue;
    }
    await cfCall(fetchFn, cfg.token, "preview route create", `${CF}/zones/${zoneId}/workers/routes`, "POST", { pattern, script });
  }
  const wildcard = `*.${domain}`;
  const records = await findDns(fetchFn, cfg.token, zoneId, wildcard);
  if (!records.length) {
    await cfCall(fetchFn, cfg.token, "preview dns create", `${CF}/zones/${zoneId}/dns_records`, "POST", {
      type: "A", name: wildcard, content: STATIC_PLACEHOLDER_IP, ttl: 1, proxied: true,
    });
  } else if (records.some((r) => r.proxied !== true)) {
    throw new PreviewRoutingUnavailable(`${wildcard} has an unproxied DNS record; it must be proxied through Cloudflare`);
  }
}

let ensured: Promise<void> | null = null;

export function ensurePreviewRouting(deps: PreviewRoutingDeps = {}): Promise<void> {
  if (!ensured) {
    ensured = ensurePreviewRoutingOnce(deps).catch((e: unknown) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

export function resetPreviewRouting(): void {
  ensured = null;
}
