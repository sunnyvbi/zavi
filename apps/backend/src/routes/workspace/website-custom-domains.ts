
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, setCustomDomainVerifyState, tenantRpc } from "@/services/tenant-client";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import { validateCustomDomainHostname } from "@/services/provisioning/custom-domain-validate";
import { detectDnsProvider } from "@/services/provisioning/dns-provider";
import {
  attachRenderCustomDomain,
  detachRenderCustomDomain,
  getRenderCustomDomainStatus,
  verifyRenderCustomDomain,
  customDomainDnsRecords,
} from "@/services/provisioning/render-custom-domain";

const WRITE_ROLES = ["owner", "admin"] as const;
const MAX_DOMAINS_PER_TENANT = 3;

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

type CustomDomainRow = {
  id: string;
  tenant_id: string;
  render_service_id: string;
  render_custom_domain_id: string | null;
  hostname: string;
  domain_type: string;
  status: string;
  dns_records: Array<{ type: string; host: string; value: string; note?: string }>;
  last_error: string | null;
  last_checked_at: string | null;
};

function publicRow(r: Partial<CustomDomainRow>) {
  return {
    id: r.id,
    hostname: r.hostname,
    domain_type: r.domain_type,
    status: r.status,
    dns_records: r.dns_records ?? [],
    last_error: r.last_error ?? null,
    last_checked_at: r.last_checked_at ?? null,
  };
}

export async function getCustomDomainsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sb = serverClientFromBearer(bearerToken(req));
  const { data, error } = await sb
    .from("tenant_custom_domains")
    .select("id, hostname, domain_type, status, dns_records, last_error, last_checked_at")
    .eq("tenant_id", auth.tenant_id)
    .order("created_at", { ascending: true });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || /does not exist/i.test(error.message)) {
      res.status(200).json({ domains: [] });
      return;
    }
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.status(200).json({ domains: (data ?? []).map(publicRow) });
}

export async function getCustomDomainDnsProviderHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const v = validateCustomDomainHostname(req.query.hostname);
  if (!v.ok) {
    res.status(400).json({ error: { code: "invalid_hostname", message: v.reason } });
    return;
  }
  const provider = await detectDnsProvider(v.hostname);
  res.status(200).json({ provider });
}

async function readBuiltinHostname(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenantId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenantId)
    .eq("resource_kind", "domain")
    .maybeSingle();
  const ref = (data as { external_ref?: Record<string, unknown> | null } | null)?.external_ref;
  const hostname = typeof ref?.hostname === "string" ? ref.hostname.trim() : "";
  return hostname || null;
}

async function readHosting(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenantId: string,
): Promise<{ serviceId: string; url: string | null } | null> {
  const { data } = await sb
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenantId)
    .eq("resource_kind", "hosting")
    .eq("mode", "provisioned")
    .order("updated_at", { ascending: false })
    .limit(1);
  const ref = (data as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0]?.external_ref;
  const serviceId = typeof ref?.render_service_id === "string" ? ref.render_service_id : "";
  if (!serviceId) return null;
  const url = typeof ref?.url === "string" ? ref.url : null;
  return { serviceId, url };
}

export async function addCustomDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const v = validateCustomDomainHostname((req.body ?? {}).hostname);
  if (!v.ok) {
    res.status(400).json({ error: { code: "invalid_hostname", message: v.reason } });
    return;
  }
  const { hostname, domain_type } = v;

  const sb = serverClientFromBearer(bearerToken(req));

  const hosting = await readHosting(sb, auth.tenant_id);
  if (!hosting) {
    res.status(409).json({ error: { code: "no_deployed_app", message: "Your app isn't deployed yet, so there's nothing to point a domain at." } });
    return;
  }
  const { data: existing } = await sb
    .from("tenant_custom_domains")
    .select("id, tenant_id, status, hostname, domain_type, dns_records")
    .eq("hostname", hostname)
    .maybeSingle();
  if (existing && existing.status === "verified") {
    res.status(200).json({ domain: publicRow(existing as Partial<CustomDomainRow>) });
    return;
  }

  const builtinHost = await readBuiltinHostname(sb, auth.tenant_id);
  if (!builtinHost) {
    res.status(409).json({ error: { code: "publish_first", message: "Publish your app first to get its Zavi address, then connect your domain to it." } });
    return;
  }

  if (!existing) {
    const { count } = await sb
      .from("tenant_custom_domains")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id);
    if ((count ?? 0) >= MAX_DOMAINS_PER_TENANT) {
      res.status(409).json({ error: { code: "too_many_domains", message: `You can connect up to ${MAX_DOMAINS_PER_TENANT} custom domains.` } });
      return;
    }
  }

  let customDomainId: string;
  try {
    const attached = await attachRenderCustomDomain(hosting.serviceId, hostname);
    customDomainId = attached.custom_domain_id;
  } catch (e) {
    if (e instanceof CredentialNotConfigured) {
      res.status(503).json({ error: { code: "hosting_unavailable", message: "Domain hosting isn't configured yet. Try again later." } });
      return;
    }
    res.status(502).json({ error: { code: "render_error", message: (e as Error).message } });
    return;
  }

  const dnsRecords = customDomainDnsRecords(hostname, `https://${builtinHost}`, domain_type);
  const { data: id, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_tenant_custom_domain", {
    p_render_service_id: hosting.serviceId,
    p_hostname: hostname,
    p_domain_type: domain_type,
    p_render_custom_domain_id: customDomainId,
    p_status: "dns_required",
    p_dns_records: dnsRecords,
  });
  if (error || !id) {
    try {
      await detachRenderCustomDomain(hosting.serviceId, customDomainId);
    } catch {
    }
    res.status(error ? 500 : 409).json({
      error: error
        ? { code: "write_failed", message: error.message }
        : { code: "domain_taken", message: "That domain is already connected to another workspace." },
    });
    return;
  }

  res.status(200).json({
    domain: publicRow({ id: id as string, hostname, domain_type, status: "dns_required", dns_records: dnsRecords, last_error: null, last_checked_at: null }),
  });
}

async function loadOwnedRow(
  sb: ReturnType<typeof serverClientFromBearer>,
  id: string,
  tenantId: string,
): Promise<CustomDomainRow | null> {
  const { data } = await sb
    .from("tenant_custom_domains")
    .select("id, tenant_id, render_service_id, render_custom_domain_id, hostname, domain_type, status, dns_records, last_error, last_checked_at")
    .eq("id", id)
    .maybeSingle();
  const row = data as CustomDomainRow | null;
  if (!row || row.tenant_id !== tenantId) return null;
  return row;
}

export async function verifyCustomDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const sb = serverClientFromBearer(bearerToken(req));
  const id = String(req.params.id ?? "");
  const row = await loadOwnedRow(sb, id, auth.tenant_id);
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Domain not found." } });
    return;
  }
  if (!row.render_custom_domain_id) {
    res.status(409).json({ error: { code: "not_attached", message: "This domain isn't attached yet." } });
    return;
  }

  try {
    await verifyRenderCustomDomain(row.render_service_id, row.render_custom_domain_id);
    const rs = await getRenderCustomDomainStatus(row.render_service_id, row.render_custom_domain_id);
    const status = rs === "verified" ? "verified" : "verifying";
    await setCustomDomainVerifyState(asTenantId(auth.tenant_id), {
      p_id: row.id,
      p_status: status,
      p_last_error: null,
    });
    res.status(200).json({ domain: publicRow({ ...row, status }) });
  } catch (e) {
    if (e instanceof CredentialNotConfigured) {
      res.status(503).json({ error: { code: "hosting_unavailable", message: "Domain hosting isn't configured yet." } });
      return;
    }
    res.status(502).json({ error: { code: "render_error", message: (e as Error).message } });
  }
}

export async function deleteCustomDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const sb = serverClientFromBearer(bearerToken(req));
  const id = String(req.params.id ?? "");
  const row = await loadOwnedRow(sb, id, auth.tenant_id);
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Domain not found." } });
    return;
  }

  if (row.render_custom_domain_id) {
    try {
      await detachRenderCustomDomain(row.render_service_id, row.render_custom_domain_id);
    } catch (e) {
      if (!(e instanceof CredentialNotConfigured)) {
        res.status(502).json({ error: { code: "render_error", message: `We couldn't release ${row.hostname} from hosting yet. Try again in a moment.` } });
        return;
      }
    }
  }

  const { error } = await sb.rpc("delete_tenant_custom_domain", { p_id: row.id });
  if (error) {
    res.status(500).json({ error: { code: "delete_failed", message: error.message } });
    return;
  }
  res.status(200).json({ ok: true });
}
