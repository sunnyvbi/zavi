
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { withKeyLock } from "@/services/keyed-lock";
import { getBoolSetting } from "@/services/settings";
import { siteIsSuspended } from "@/services/website/site-offline";
import { buildDatabaseReclaimed, oldFlowBuildUnshipped } from "@/services/autopilot/build-liveness";
import { loadLatestLegacyBuild } from "@/services/sites/legacy-app";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import {
  validateBuiltinLabel,
  builtinBaseDomain,
  setBuiltinSubdomain,
  clearBuiltinSubdomain,
  defaultBuiltinLabel,
  suffixedBuiltinLabel,
  type BuiltinSubdomainRef,
} from "@/services/provisioning/builtin-url";
import { getRenderCustomDomainStatus, verifyRenderCustomDomain } from "@/services/provisioning/render-custom-domain";
import { BUILTIN_HOST_IN_USE, ensureDnsCname } from "@/services/provisioning/cloudflare-dns";
import {
  advanceBuiltinDomain,
  noteBuiltinVerifyRequested,
  type BuiltinHealDeps,
} from "@/services/provisioning/builtin-domain-heal";

const WRITE_ROLES = ["owner", "admin"] as const;

function withBuiltinUrlLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`builtin-url:${tenantId}`, fn);
}

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

type BuiltinRef = BuiltinSubdomainRef & { status?: string };

function dnsWriterConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID);
}

function publicBuiltin(ref: BuiltinRef | null) {
  if (!ref?.hostname) return null;
  const status = ref.status ?? "verifying";
  const dns_ready = typeof ref.dns_record_id === "string" && ref.dns_record_id.length > 0;
  const blocked = status !== "live" && status !== "retired" && !dns_ready && !dnsWriterConfigured();
  return {
    label: ref.label ?? ref.hostname.split(".")[0],
    hostname: ref.hostname,
    url: `https://${ref.hostname}`,
    status,
    dns_ready,
    ...(blocked ? { setup_blocked: "dns_not_configured" as const } : {}),
  };
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
  return { serviceId, url: typeof ref?.url === "string" ? ref.url : null };
}

type Sb = ReturnType<typeof serverClientFromBearer>;
type Hosting = { serviceId: string; url: string | null };

function healDeps(sb: Sb, tenantId: string): BuiltinHealDeps {
  return {
    baseDomain: builtinBaseDomain(),
    async loadHosting() {
      const hosting = await readHosting(sb, tenantId);
      return hosting ? { serviceId: hosting.serviceId, url: hosting.url } : null;
    },
    ensureCname: (hostname, target) => ensureDnsCname(hostname, target, {}, false, { onlyReplaceOnrender: true }),
    renderStatus: (serviceId, idOrHost) => getRenderCustomDomainStatus(serviceId, idOrHost),
    requestVerify: (serviceId, customDomainId) => verifyRenderCustomDomain(serviceId, customDomainId),
    async save(_tenant, external_ref) {
      const { error } = await sb.rpc("set_tenant_builtin_domain", {
        p_tenant_id: tenantId,
        p_external_ref: external_ref,
        p_status: "ready",
      });
      if (error) throw new Error(error.message);
    },
  };
}

async function reconcileBuiltin(sb: Sb, tenantId: string, ref: BuiltinRef | null): Promise<BuiltinRef | null> {
  if (!ref?.hostname || ref.status === "live") return ref;
  const deps = healDeps(sb, tenantId);
  const next: Record<string, unknown> = { ...ref };
  try {
    const outcome = await advanceBuiltinDomain(
      { tenant_id: tenantId, external_ref: ref as unknown as Record<string, unknown> },
      {
        ...deps,
        async save(tenant, external_ref) {
          Object.assign(next, external_ref);
          await deps.save(tenant, external_ref);
        },
      },
    );
    if (outcome === "skipped" && !ref.status) return ref;
    return next as unknown as BuiltinRef;
  } catch {
    return (next.status ? next : ref) as BuiltinRef | null;
  }
}

export async function getBuiltinUrlHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sb = serverClientFromBearer(bearerToken(req));
  const reconciled = await withBuiltinUrlLock(auth.tenant_id, async () =>
    reconcileBuiltin(sb, auth.tenant_id, await readPrev(sb, auth.tenant_id)),
  );
  const ref = (await buildRetired(sb, auth.tenant_id, reconciled))
    ? { ...reconciled!, status: "retired" }
    : await withOfflineStatus(auth.tenant_id, await withBuildShippedStatus(sb, auth.tenant_id, reconciled));
  const custom_domain_attached = (await hasCustomDomain(sb, auth.tenant_id)) !== false;
  res.status(200).json({ builtin: publicBuiltin(ref), base_domain: builtinBaseDomain(), custom_domain_attached });
}

async function buildRetired(sb: Sb, tenantId: string, ref: BuiltinRef | null): Promise<boolean> {
  if (!ref?.hostname) return false;
  try {
    const [{ data: dbRows, error }, build] = await Promise.all([
      sb.from("tenant_resources").select("resource_kind, status, updated_at").eq("tenant_id", tenantId).eq("resource_kind", "db"),
      loadLatestLegacyBuild(sb, tenantId),
    ]);
    return !error && buildDatabaseReclaimed(dbRows as Array<{ resource_kind: string; status: string; updated_at?: string | null }> | null, build);
  } catch {
    return false;
  }
}

async function withBuildShippedStatus(sb: Sb, tenantId: string, ref: BuiltinRef | null): Promise<BuiltinRef | null> {
  if (!ref?.hostname || ref.status !== "live") return ref;
  return (await oldFlowBuildUnshipped(sb, tenantId)) ? { ...ref, status: "not_live" } : ref;
}

async function withOfflineStatus(tenantId: string, ref: BuiltinRef | null): Promise<BuiltinRef | null> {
  if (!ref?.hostname || ref.status !== "live") return ref;
  try {
    if (!(await getBoolSetting("build_site_offline_status", tenantId))) return ref;
    return (await siteIsSuspended(`https://${ref.hostname}`)) === true ? { ...ref, status: "offline" } : ref;
  } catch {
    return ref;
  }
}

async function hasCustomDomain(sb: Sb, tenantId: string): Promise<boolean | null> {
  const { count, error } = await sb
    .from("tenant_custom_domains")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (error) {
    const code = (error as { code?: string }).code;
    return code === "42P01" || /does not exist/i.test(error.message ?? "") ? false : null;
  }
  return (count ?? 0) > 0;
}

async function refuseIfCustomDomain(sb: Sb, tenantId: string, res: Response): Promise<boolean> {
  const attached = await hasCustomDomain(sb, tenantId);
  if (attached === false) return false;
  if (attached === null) {
    res.status(503).json({ error: { code: "custom_domain_check_failed", message: "We couldn't check your custom domains. Try again." } });
    return true;
  }
  res.status(409).json({
    error: { code: "custom_domain_attached", message: "Remove your custom domain first to change your Zavi address." },
  });
  return true;
}

type ApplyResult =
  | { ok: true; builtin: ReturnType<typeof publicBuiltin> }
  | { ok: false; status: number; code: string; message: string };

async function applyBuiltinLabel(
  sb: Sb,
  tenantId: string,
  hosting: Hosting,
  prev: BuiltinRef | null,
  label: string,
): Promise<ApplyResult> {
  const hostname = `${label}.${builtinBaseDomain()}`;
  if (prev?.hostname === hostname && prev?.status === "live") {
    return { ok: true, builtin: publicBuiltin(prev) };
  }
  try {
    const ref = await setBuiltinSubdomain(hosting.serviceId, hosting.url, label);
    if (ref.dns_record_id && ref.custom_domain_id) {
      await verifyRenderCustomDomain(hosting.serviceId, ref.custom_domain_id).catch(() => undefined);
      noteBuiltinVerifyRequested(hostname);
    }
    let status = "verifying";
    try {
      const rs = await getRenderCustomDomainStatus(hosting.serviceId, ref.custom_domain_id ?? hostname);
      if (rs === "verified") status = "live";
    } catch {
      status = "verifying";
    }
    const external_ref = { ...ref, status, render_service_id: hosting.serviceId };
    const { error } = await sb.rpc("set_tenant_builtin_domain", {
      p_tenant_id: tenantId,
      p_external_ref: external_ref,
      p_status: "ready",
    });
    if (error) {
      if (prev?.hostname !== ref.hostname) {
        try {
          await clearBuiltinSubdomain(hosting.serviceId, { hostname: ref.hostname, custom_domain_id: ref.custom_domain_id });
        } catch {}
      }
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        return { ok: false, status: 409, code: "label_taken", message: "That URL is already taken. Try another." };
      }
      return { ok: false, status: 500, code: "write_failed", message: error.message };
    }
    if (prev?.hostname && prev.hostname !== hostname) {
      try {
        await clearBuiltinSubdomain(hosting.serviceId, { hostname: prev.hostname, custom_domain_id: prev.custom_domain_id });
      } catch {
      }
    }
    return { ok: true, builtin: publicBuiltin({ ...ref, status }) };
  } catch (e) {
    if (e instanceof CredentialNotConfigured) {
      return { ok: false, status: 503, code: "hosting_unavailable", message: "Custom URLs aren't available yet. Try again later." };
    }
    if ((e as Error).message === BUILTIN_HOST_IN_USE) {
      return { ok: false, status: 409, code: "label_taken", message: "That URL is already taken. Try another." };
    }
    return { ok: false, status: 502, code: "provider_error", message: (e as Error).message };
  }
}

function sendApplyFailure(res: Response, r: Extract<ApplyResult, { ok: false }>): void {
  res.status(r.status).json({ error: { code: r.code, message: r.message } });
}

async function readPrev(sb: Sb, tenantId: string): Promise<BuiltinRef | null> {
  const { data: curRow } = await sb
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenantId)
    .eq("resource_kind", "domain")
    .maybeSingle();
  return ((curRow as { external_ref?: Record<string, unknown> | null } | null)?.external_ref ?? null) as BuiltinRef | null;
}

export async function setBuiltinUrlHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const v = validateBuiltinLabel((req.body ?? {}).label);
  if (!v.ok) {
    res.status(400).json({ error: { code: "invalid_label", message: v.reason } });
    return;
  }

  const sb = serverClientFromBearer(bearerToken(req));
  await withBuiltinUrlLock(auth.tenant_id, async () => {
    const hosting = await readHosting(sb, auth.tenant_id);
    if (!hosting) {
      res.status(409).json({ error: { code: "no_deployed_app", message: "Your app isn't deployed yet." } });
      return;
    }
    const prev = await readPrev(sb, auth.tenant_id);
    if (prev?.hostname && prev.hostname !== `${v.label}.${builtinBaseDomain()}` && (await refuseIfCustomDomain(sb, auth.tenant_id, res))) return;
    const r = await applyBuiltinLabel(sb, auth.tenant_id, hosting, prev, v.label);
    if (!r.ok) {
      sendApplyFailure(res, r);
      return;
    }
    res.status(200).json({ builtin: r.builtin });
  });
}

export async function ensureBuiltinUrlHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const sb = serverClientFromBearer(bearerToken(req));
  await withBuiltinUrlLock(auth.tenant_id, async () => {
    const prev = await readPrev(sb, auth.tenant_id);
    if (prev?.hostname) {
      const ref = await reconcileBuiltin(sb, auth.tenant_id, prev);
      res.status(200).json({ builtin: publicBuiltin(ref), base_domain: builtinBaseDomain(), created: false });
      return;
    }

    const hosting = await readHosting(sb, auth.tenant_id);
    if (!hosting) {
      res.status(409).json({ error: { code: "no_deployed_app", message: "Your app isn't built yet, so there's nothing to publish." } });
      return;
    }

    const { data: tenant } = await sb
      .from("tenants")
      .select("slug, display_name")
      .eq("id", auth.tenant_id)
      .maybeSingle();
    const source = (tenant as { slug?: string | null; display_name?: string | null } | null) ?? null;
    const label = defaultBuiltinLabel(source?.slug || source?.display_name || "", auth.tenant_id);

    let r = await applyBuiltinLabel(sb, auth.tenant_id, hosting, null, label);
    if (!r.ok && r.code === "label_taken") {
      r = await applyBuiltinLabel(sb, auth.tenant_id, hosting, null, suffixedBuiltinLabel(label, auth.tenant_id));
    }
    if (!r.ok) {
      sendApplyFailure(res, r);
      return;
    }
    res.status(200).json({ builtin: r.builtin, base_domain: builtinBaseDomain(), created: true });
  });
}

export async function deleteBuiltinUrlHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const sb = serverClientFromBearer(bearerToken(req));
  await withBuiltinUrlLock(auth.tenant_id, async () => {
    const prev = await readPrev(sb, auth.tenant_id);
    if (prev?.hostname && (await refuseIfCustomDomain(sb, auth.tenant_id, res))) return;

    const hosting = await readHosting(sb, auth.tenant_id);
    if (hosting && prev?.hostname) {
      try {
        await clearBuiltinSubdomain(hosting.serviceId, { hostname: prev.hostname, custom_domain_id: prev.custom_domain_id });
      } catch (e) {
        res.status(502).json({ error: { code: "provider_error", message: (e as Error).message } });
        return;
      }
    }

    const { error } = await sb.rpc("set_tenant_builtin_domain", {
      p_tenant_id: auth.tenant_id,
      p_external_ref: {},
      p_status: "ready",
    });
    if (error) {
      res.status(500).json({ error: { code: "write_failed", message: error.message } });
      return;
    }
    res.status(200).json({ builtin: null });
  });
}
