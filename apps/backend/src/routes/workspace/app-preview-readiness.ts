import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { builtinBaseDomain, isBuiltinHostname } from "@/services/provisioning/builtin-url";
import { siteStore } from "@/services/sites/store";
import type { SiteRow } from "@/services/sites/contract";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { probeSandboxDevServer } from "@/services/sandbox/preview-ready-probe";

export { sameOriginModuleScripts } from "@/services/sandbox/preview-ready-probe";

export type AppReadinessState = "ready" | "waking" | "suspended";

export const READINESS_PROBE_TIMEOUT_MS = 20_000;

const inflight = new Map<string, Promise<AppReadinessState>>();

function httpsHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isSiteHost(host: string): boolean {
  const suffix = `.${builtinBaseDomain().toLowerCase()}`;
  if (!host.endsWith(suffix)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host.slice(0, -suffix.length));
}

const SITE_GONE = new Set(["deleting", "deleted", "fell_back_old"]);

export async function tenantSiteHosts(
  tenantId: string,
  listSites: (tenant_id: string) => Promise<SiteRow[]> = async (t) => siteStore().listForTenant(t),
): Promise<Set<string>> {
  const hosts = new Set<string>();
  const sites = await listSites(tenantId);
  for (const site of sites) {
    if (site.tenant_id !== tenantId || SITE_GONE.has(site.status)) continue;
    for (const host of [site.hostname?.trim().toLowerCase(), httpsHost(site.live_url)]) {
      if (host && isSiteHost(host)) hosts.add(host);
    }
  }
  return hosts;
}

async function tenantAppHosts(accessToken: string, tenantId: string): Promise<Set<string>> {
  const sb = serverClientFromBearer(accessToken);
  const { data } = await sb
    .from("tenant_resources")
    .select("resource_kind, external_ref")
    .eq("tenant_id", tenantId)
    .in("resource_kind", ["hosting", "domain"]);
  const hosts = new Set<string>();
  for (const row of (data ?? []) as Array<{ resource_kind?: string; external_ref?: Record<string, unknown> | null }>) {
    const ref = row.external_ref ?? {};
    if (row.resource_kind === "hosting") {
      const host = httpsHost(ref.url);
      if (host && host.endsWith(".onrender.com")) hosts.add(host);
    } else if (row.resource_kind === "domain" && isBuiltinHostname(ref.hostname)) {
      hosts.add(String(ref.hostname).trim().toLowerCase());
    }
  }
  return hosts;
}

const SANDBOX_HOST_RE = /^[0-9]{2,5}-[a-z0-9]{6,64}\.e2b\.(app|dev)$/;

export function isSandboxPreviewHost(host: string): boolean {
  return SANDBOX_HOST_RE.test(host.toLowerCase());
}

async function tenantSandboxHosts(tenantId: string): Promise<Set<string>> {
  const hosts = new Set<string>();
  try {
    const { data } = await (tenantClient(asTenantId(tenantId))
      .from("tenant_sandbox")
      .select("preview_url") as any)
      .not("preview_url", "is", null);
    for (const row of (data ?? []) as Array<{ preview_url?: unknown }>) {
      const host = httpsHost(row.preview_url);
      if (host && isSandboxPreviewHost(host)) hosts.add(host);
    }
  } catch {
  }
  return hosts;
}

export function classifyProbeResponse(headers: Headers): AppReadinessState {
  const routing = headers.get("x-render-routing");
  if (routing === null) return "ready";
  return routing.trim().toLowerCase().startsWith("suspend") ? "suspended" : "waking";
}

async function runProbe(url: string): Promise<AppReadinessState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "ZaviPreviewCheck/1.0" },
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => undefined);
    return classifyProbeResponse(response.headers);
  } catch {
    return "waking";
  } finally {
    clearTimeout(timer);
  }
}

export function probeAppReadiness(url: string, kind: "app" | "sandbox" = "app"): Promise<AppReadinessState> {
  const key = `${kind}:${url}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = kind === "sandbox"
    ? probeSandboxDevServer(new URL(url).origin).then((ready): AppReadinessState => (ready ? "ready" : "waking"))
    : runProbe(url);
  const pending = run.finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

type OwnPreviewTarget = { target: URL; sandbox: boolean };

async function ownPreviewTarget(req: Request, res: Response): Promise<OwnPreviewTarget | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;

  const raw = typeof req.query.url === "string" ? req.query.url.trim() : "";
  let target: URL | null = null;
  try {
    target = raw ? new URL(raw) : null;
  } catch {
    target = null;
  }
  if (!target || target.protocol !== "https:" || target.port !== "" || target.username || target.password) {
    res.status(400).json({ error: { code: "bad_url", message: "url must be one of your app's https addresses" } });
    return null;
  }

  const host = target.hostname.toLowerCase();
  const sandbox = isSandboxPreviewHost(host);
  const hosts = sandbox
    ? await tenantSandboxHosts(auth.tenant_id)
    : await tenantAppHosts(auth.access_token, auth.tenant_id);
  if (!sandbox && !hosts.has(host) && isSiteHost(host)) {
    try {
      for (const h of await tenantSiteHosts(auth.tenant_id)) hosts.add(h);
    } catch {
      res.status(503).json({ error: { code: "readiness_check_failed", message: "couldn't check this address just now" } });
      return null;
    }
  }
  if (!hosts.has(host)) {
    res.status(400).json({ error: { code: "bad_url", message: "url must be one of your app's https addresses" } });
    return null;
  }
  return { target, sandbox };
}

export async function getAppPreviewReadinessHandler(req: Request, res: Response): Promise<void> {
  const own = await ownPreviewTarget(req, res);
  if (!own) return;
  const state = await probeAppReadiness(`${own.target.origin}/`, own.sandbox ? "sandbox" : "app");
  res.set("Cache-Control", "no-store");
  res.status(200).json({ state });
}
