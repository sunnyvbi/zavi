
import { registerBuiltinProvisioners } from "./index";
import { resolveResources, type ResolveSummary, type ResolveResourcesHooks } from "./resolve-resources";
import type { ResourceKind } from "./types";
import { ensureManagedOperatorDb } from "./managed-operator-db";

export const ALL_RESOURCE_KINDS: readonly ResourceKind[] = [
  "repo",
  "db",
  "hosting",
  "email",
  "domain",
  "stripe",
  "ads",
] as const;

export type ProvisionCompanyDeps = {
  register?: () => void;
  resolve?: (
    tenant_id: string,
    company_name: string,
    kinds: ResourceKind[],
    hooks?: ResolveResourcesHooks,
  ) => Promise<ResolveSummary>;
  afterDbProvisioned?: (tenant_id: string) => Promise<unknown>;
};

export async function provisionCompany(
  tenant_id: string,
  company_name: string,
  kinds: ResourceKind[] = [...ALL_RESOURCE_KINDS],
  deps: ProvisionCompanyDeps = {},
  hooks: ResolveResourcesHooks = {},
): Promise<ResolveSummary> {
  (deps.register ?? registerBuiltinProvisioners)();
  const afterDb = deps.afterDbProvisioned ?? ensureManagedOperatorDb;
  const callerHook = hooks.afterProvision;
  hooks = {
    ...hooks,
    async afterProvision(kind, context) {
      if (callerHook) await callerHook(kind, context);
      if (kind !== "db") return;
      try {
        const outcome = await afterDb(tenant_id);
        console.info(`[provision-company] tenant=${tenant_id} operator-db: ${String(outcome)}`);
      } catch (e) {
        console.warn(`[provision-company] tenant=${tenant_id} operator-db connect failed: ${(e as Error)?.name ?? "error"}`);
      }
    },
  };
  const resolve = deps.resolve ?? ((t, c, k, h) => resolveResources(t, c, k, undefined, h));
  return resolve(tenant_id, company_name, kinds, hooks);
}
