
import { cfCall, findRoute, matchingWildcardRoute, staticHostingConfig, type CfRoute, type StaticFetch } from "@/services/hosting/static-publish";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import { bindingKey } from "./gateway-kv";

const CF = "https://api.cloudflare.com/client/v4";
export const GATEWAY_WORKER_ENV = "ZAVI_SITE_GATEWAY_WORKER_NAME";

export interface GatewayRoutes {
  ensure(hostname: string): Promise<void>;
  remove(hostname: string): Promise<void>;
}

export function gatewayRoutePattern(hostname: string): string {
  return `${bindingKey(hostname).slice("host:".length)}/api/*`;
}

export function cloudflareGatewayRoutes(deps: { env?: Record<string, string | undefined>; fetchFn?: StaticFetch } = {}): GatewayRoutes {
  const env = deps.env ?? process.env;
  const fetchFn: StaticFetch = deps.fetchFn ?? ((globalThis as unknown as { fetch: StaticFetch }).fetch);
  function cfg() {
    const c = staticHostingConfig(env);
    const worker = (env[GATEWAY_WORKER_ENV] ?? "").trim();
    const missing = [...(c.ok ? [] : c.missing), ...(worker ? [] : [GATEWAY_WORKER_ENV])];
    if (!c.ok || missing.length) throw new SiteCredentialsMissing(missing);
    return { token: c.token, zoneId: c.zoneId, worker };
  }
  return {
    async ensure(hostname) {
      const { token, zoneId, worker } = cfg();
      const pattern = gatewayRoutePattern(hostname);
      const routes = ((await cfCall(fetchFn, token, "workers routes list", `${CF}/zones/${zoneId}/workers/routes`)) as CfRoute[] | undefined) ?? [];
      const route = routes.find((r) => (r.pattern ?? "").toLowerCase() === pattern);
      if (route) {
        if (route.script !== worker) throw new Error(`route ${pattern} belongs to another worker`);
        return;
      }
      const host = pattern.slice(0, -"/api/*".length);
      const exactSite = routes.some((r) => (r.pattern ?? "").toLowerCase() === `${host}/*`);
      if (!exactSite && matchingWildcardRoute(routes, host, "/api/*")?.script === worker) return;
      await cfCall(fetchFn, token, "gateway route create", `${CF}/zones/${zoneId}/workers/routes`, "POST", { pattern, script: worker });
    },
    async remove(hostname) {
      const { token, zoneId, worker } = cfg();
      const pattern = gatewayRoutePattern(hostname);
      const route = await findRoute(fetchFn, token, zoneId, pattern);
      if (!route?.id) return;
      if (route.script !== worker) throw new Error(`route ${pattern} belongs to another worker`);
      await cfCall(fetchFn, token, "gateway route delete", `${CF}/zones/${zoneId}/workers/routes/${encodeURIComponent(route.id)}`, "DELETE");
    },
  };
}
