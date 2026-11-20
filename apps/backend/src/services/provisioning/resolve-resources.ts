
import { serviceClient } from "@/services/supabase";
import { getProvisioner } from "./registry";
import { CredentialNotConfigured } from "./github-repo";
import type { ResourceKind, ResourceMode, Provisioner } from "./types";

const RESOURCE_ORDER: readonly ResourceKind[] = [
  "repo",
  "db",
  "hosting",
  "email",
  "domain",
  "stripe",
  "ads",
] as const;

export const RESOURCE_DEPENDENCIES: Readonly<Record<ResourceKind, readonly ResourceKind[]>> = {
  repo: [],
  db: [],
  hosting: ["repo", "db"],
  email: [],
  domain: ["hosting"],
  stripe: [],
  ads: [],
};

type KindOutcome =
  | { kind: ResourceKind; status: "connected" }
  | { kind: ResourceKind; status: "provisioned" }
  | { kind: ResourceKind; status: "pending"; missing_key: string }
  | { kind: ResourceKind; status: "failed"; error: string };

export type ResolveSummary = {
  provisioned: ResourceKind[];
  connected: ResourceKind[];
  pending_creds: Array<{ kind: ResourceKind; missing_key: string }>;
  failed: Array<{ kind: ResourceKind; error: string }>;
  context: Record<string, unknown>;
};

export type ResolveResourcesDeps = {
  loadMode: (tenant_id: string, kind: ResourceKind) => Promise<ResourceMode | null>;
  loadVaultKey: (tenant_id: string, kind: ResourceKind) => Promise<string | null>;
  loadExternalRef: (
    tenant_id: string,
    kind: ResourceKind,
  ) => Promise<Record<string, unknown> | null>;
  getProvisioner: (kind: ResourceKind) => Provisioner | null;
  setTenantResource: (
    tenant_id: string,
    kind: ResourceKind,
    mode: ResourceMode,
    status: string,
    provider: string | null,
    external_ref: Record<string, unknown>,
    vault_key: string | null,
  ) => Promise<void>;
};

export type ResolveResourcesHooks = {
  afterProvision?: (
    kind: ResourceKind,
    context: Record<string, unknown>,
  ) => Promise<void>;
};

export const realResolveResourcesDeps: ResolveResourcesDeps = {
  async loadMode(tenant_id, kind) {
    const { data } = await serviceClient()
      .from("tenant_resources")
      .select("mode")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", kind)
      .maybeSingle();
    return (data as { mode?: ResourceMode } | null)?.mode ?? null;
  },
  async loadVaultKey(tenant_id, kind) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("vault_key")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", kind)
      .maybeSingle();
    if (error) {
      throw new Error(`tenant_resources vault_key read failed (${kind}): ${error.message}`);
    }
    return (data as { vault_key?: string | null } | null)?.vault_key ?? null;
  },
  async loadExternalRef(tenant_id, kind) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("external_ref, status")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", kind)
      .maybeSingle();
    if (error) {
      throw new Error(`tenant_resources external_ref read failed (${kind}): ${error.message}`);
    }
    const row = data as { external_ref?: unknown; status?: string } | null;
    if (row?.status === "torn_down" || row?.status === "teardown") return null;
    const ref = row?.external_ref;
    return ref && typeof ref === "object" ? (ref as Record<string, unknown>) : null;
  },
  getProvisioner,
  async setTenantResource(tenant_id, kind, mode, status, provider, external_ref, vault_key) {
    const { error } = await serviceClient().rpc("set_tenant_resource", {
      p_tenant_id: tenant_id,
      p_resource_kind: kind,
      p_mode: mode,
      p_status: status,
      p_provider: provider,
      p_external_ref: external_ref,
      p_vault_key: vault_key,
    });
    if (error) throw new Error(`set_tenant_resource failed (${kind}): ${error.message}`);
  },
};

export async function resolveResources(
  tenant_id: string,
  company_name: string,
  kinds: ResourceKind[],
  deps: ResolveResourcesDeps = realResolveResourcesDeps,
  hooks: ResolveResourcesHooks = {},
): Promise<ResolveSummary> {
  const ordered = RESOURCE_ORDER.filter((k) => kinds.includes(k));
  const context: Record<string, unknown> = {};
  const summary: ResolveSummary = {
    provisioned: [],
    connected: [],
    pending_creds: [],
    failed: [],
    context,
  };

  const resolveOne = async (kind: ResourceKind, blocked: () => boolean): Promise<KindOutcome | null> => {
    const mode: ResourceMode = (await deps.loadMode(tenant_id, kind)) ?? "provisioned";
    if (mode === "connected") {
      return { kind, status: "connected" };
    }
    const prov = deps.getProvisioner(kind);
    if (!prov) {
      return { kind, status: "failed", error: "no provisioner registered" };
    }
    let existing_ref: Record<string, unknown> | null = null;
    try {
      existing_ref = await deps.loadExternalRef(tenant_id, kind);
    } catch (e) {
      return { kind, status: "failed", error: (e as Error).message };
    }
    if (blocked()) return null;
    try {
      const result = await prov.ensure({ tenant_id, company_name, context, existing_ref });
      Object.assign(context, result.external_ref);
      const newVaultKey = Object.values(result.vault_keys)[0] ?? null;
      const vault_key = newVaultKey ?? (await deps.loadVaultKey(tenant_id, kind));
      const status = prov.initialStatus ? prov.initialStatus(result) : "ready";
      const sameService =
        typeof existing_ref?.render_service_id === "string" &&
        existing_ref.render_service_id === result.external_ref.render_service_id;
      const sameRepo =
        typeof existing_ref?.github_full_name === "string" &&
        existing_ref.github_full_name === result.external_ref.github_full_name;
      const external_ref =
        kind === "hosting" && sameService && existing_ref?.static !== undefined && result.external_ref.static === undefined
          ? { ...result.external_ref, static: existing_ref.static }
          : kind === "repo"
            ? {
                ...result.external_ref,
                ...(sameRepo && existing_ref?.export !== undefined && result.external_ref.export === undefined
                  ? { export: existing_ref.export }
                  : {}),
                ...(existing_ref?.exports !== undefined && result.external_ref.exports === undefined
                  ? { exports: existing_ref.exports }
                  : {}),
              }
            : result.external_ref;
      await deps.setTenantResource(tenant_id, kind, "provisioned", status, prov.provider, external_ref, vault_key);
      if (hooks.afterProvision) {
        try {
          await hooks.afterProvision(kind, context);
        } catch {
        }
      }
      return { kind, status: "provisioned" };
    } catch (e) {
      const priorRef = existing_ref ?? {};
      let priorKey: string | null;
      try {
        priorKey = await deps.loadVaultKey(tenant_id, kind);
      } catch (keyErr) {
        return {
          kind,
          status: "failed",
          error: `${(e as Error).message ?? "provisioning failed"} (row left untouched: ${(keyErr as Error).message})`,
        };
      }
      if (e instanceof CredentialNotConfigured) {
        await deps.setTenantResource(
          tenant_id, kind, "provisioned", "pending", prov.provider, { ...priorRef }, priorKey,
        );
        return { kind, status: "pending", missing_key: e.key };
      } else {
        const error = (e as Error).message ?? "unknown provisioning error";
        await deps.setTenantResource(
          tenant_id, kind, "provisioned", "failed", prov.provider,
          { ...priorRef, error: error.slice(0, 300) }, priorKey,
        );
        return { kind, status: "failed", error };
      }
    }
  };

  const fatal = new Map<ResourceKind, unknown>();
  const position = (k: ResourceKind) => ordered.indexOf(k);
  const blockedByEarlierFatal = (kind: ResourceKind) =>
    [...fatal.keys()].some((f) => position(f) < position(kind));
  const runs = new Map<ResourceKind, Promise<KindOutcome | null>>();
  const run = (kind: ResourceKind): Promise<KindOutcome | null> => {
    const existing = runs.get(kind);
    if (existing) return existing;
    const upstream = RESOURCE_DEPENDENCIES[kind].filter((d) => ordered.includes(d));
    const waitFor = kind !== "repo" && ordered.includes("repo") ? [...upstream, "repo" as const] : upstream;
    const p = Promise.all(waitFor.map(run)).then(async () => {
      const blocked = () => blockedByEarlierFatal(kind);
      if (blocked()) return null;
      try {
        return await resolveOne(kind, blocked);
      } catch (e) {
        fatal.set(kind, e);
        return null;
      }
    });
    runs.set(kind, p);
    return p;
  };

  const outcomes = await Promise.all(ordered.map(run));
  const firstFatal = ordered.find((k) => fatal.has(k));
  if (firstFatal) throw fatal.get(firstFatal);

  for (const o of outcomes) {
    if (!o) continue;
    if (o.status === "connected") summary.connected.push(o.kind);
    else if (o.status === "provisioned") summary.provisioned.push(o.kind);
    else if (o.status === "pending") summary.pending_creds.push({ kind: o.kind, missing_key: o.missing_key });
    else summary.failed.push({ kind: o.kind, error: o.error });
  }
  return summary;
}
