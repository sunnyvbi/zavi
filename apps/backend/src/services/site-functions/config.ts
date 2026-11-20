
export class SiteFunctionsUnavailable extends Error {
  readonly code = "functions_unavailable";
  constructor(public missing: string[] | string) {
    super(`site functions are not configured${Array.isArray(missing) ? ` (missing ${missing.join(", ")})` : `: ${missing}`}`);
  }
}

export interface SiteFunctionsConfig {
  accountId: string;
  token: string;
  namespace: string;
  tailWorker: string;
  dispatchUrl: string;
  dispatchSecret: string;
}

type Env = Record<string, string | undefined>;

export function siteFunctionsConfig(env: Env = process.env): { ok: true; config: SiteFunctionsConfig } | { ok: false; missing: string[] } {
  const v = (k: string) => (env[k] ?? "").trim();
  const values = {
    accountId: v("CLOUDFLARE_ACCOUNT_ID"),
    token: v("CLOUDFLARE_WFP_API_TOKEN") || v("CLOUDFLARE_STATIC_API_TOKEN"),
    namespace: v("SITE_FN_NAMESPACE"),
    tailWorker: v("SITE_FN_TAIL_WORKER"),
    dispatchUrl: v("SITE_FN_DISPATCH_URL"),
    dispatchSecret: v("SITE_FN_DISPATCH_SECRET"),
  };
  const names: Record<keyof typeof values, string> = {
    accountId: "CLOUDFLARE_ACCOUNT_ID",
    token: "CLOUDFLARE_WFP_API_TOKEN",
    namespace: "SITE_FN_NAMESPACE",
    tailWorker: "SITE_FN_TAIL_WORKER",
    dispatchUrl: "SITE_FN_DISPATCH_URL",
    dispatchSecret: "SITE_FN_DISPATCH_SECRET",
  };
  const missing = (Object.keys(values) as (keyof typeof values)[]).filter((k) => !values[k]).map((k) => names[k]);
  if (missing.length) return { ok: false, missing };
  if (!/^[a-z0-9-]{3,63}$/.test(values.namespace)) return { ok: false, missing: ["SITE_FN_NAMESPACE (invalid)"] };
  if (!/^https:\/\/[a-z0-9.-]+\/v1\/invoke$/.test(values.dispatchUrl)) return { ok: false, missing: ["SITE_FN_DISPATCH_URL (must be https://<host>/v1/invoke)"] };
  return { ok: true, config: values };
}

export function requireSiteFunctionsConfig(env: Env = process.env): SiteFunctionsConfig {
  const c = siteFunctionsConfig(env);
  if (!c.ok) throw new SiteFunctionsUnavailable(c.missing);
  return c.config;
}

export function liveScriptName(siteId: string, generation: number): string {
  return `zfn-${siteId.replace(/-/g, "").toLowerCase()}-${generation}`;
}
export function testScriptName(testSiteId: string): string {
  return `zft-${testSiteId.replace(/-/g, "").toLowerCase()}`;
}
