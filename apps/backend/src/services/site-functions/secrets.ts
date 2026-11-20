
import type { WfpApi } from "./cf-api";
import { SECRET_NAME_RE } from "./manifest";
import type { SiteFunctionsStore } from "./store";

export class SecretInputError extends Error {
  readonly code = "invalid_secret";
}

export interface SecretDeps {
  store: SiteFunctionsStore;
  wfp: () => WfpApi;
  log?: (line: Record<string, unknown>) => void;
}

const MAX_VALUE_BYTES = 8192;
const MIN_VALUE_BYTES = 8;

function checkName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name) || name.startsWith("ZAVI_")) {
    throw new SecretInputError("Secret names are UPPER_SNAKE_CASE (2-64 chars) and may not start with ZAVI_.");
  }
  return name;
}

function checkScope(scope: unknown): "live" | "test" {
  if (scope === undefined || scope === "live") return "live";
  if (scope === "test") return "test";
  throw new SecretInputError('scope must be "live" or "test".');
}

async function activeScript(store: SiteFunctionsStore, tenant_id: string, site_id: string): Promise<string | null> {
  const o = await store.overview(tenant_id, site_id);
  const st = o.state as { active_script?: unknown; status?: unknown } | null | undefined;
  return st && typeof st.active_script === "string" && st.status !== "deleting" && st.status !== "deleted" ? st.active_script : null;
}

export async function putSiteSecret(deps: SecretDeps, input: { tenant_id: string; site_id: string; name: unknown; value: unknown; scope?: unknown }) {
  const name = checkName(input.name);
  const scope = checkScope(input.scope);
  if (typeof input.value !== "string" || Buffer.byteLength(input.value, "utf8") < MIN_VALUE_BYTES || Buffer.byteLength(input.value, "utf8") > MAX_VALUE_BYTES) {
    throw new SecretInputError(`Secret values are ${MIN_VALUE_BYTES}..${MAX_VALUE_BYTES} bytes.`);
  }
  const saved = await deps.store.secretSet(input.tenant_id, input.site_id, scope, name, input.value);
  let applied = scope === "test";
  if (scope === "live") {
    const script = await activeScript(deps.store, input.tenant_id, input.site_id);
    if (!script) applied = true;
    else {
      try {
        applied = (await deps.wfp().putSecret(script, name, input.value)) === "ok";
      } catch (e) {
        applied = false;
        (deps.log ?? ((l) => console.warn(JSON.stringify(l))))({ evt: "site_functions", step: "secret_push", outcome: "failed", site_id: input.site_id, name, error: (e as Error).message });
      }
    }
  }
  return { name: saved.name, scope: saved.scope, updated_at: saved.updated_at, rotated: saved.rotated, applied };
}

export async function deleteSiteSecret(deps: SecretDeps, input: { tenant_id: string; site_id: string; name: unknown; scope?: unknown }) {
  const name = checkName(input.name);
  const scope = checkScope(input.scope);
  const deleted = await deps.store.secretDelete(input.tenant_id, input.site_id, scope, name);
  let applied = true;
  if (deleted && scope === "live") {
    const script = await activeScript(deps.store, input.tenant_id, input.site_id);
    if (script) {
      try {
        await deps.wfp().deleteSecret(script, name);
      } catch (e) {
        applied = false;
        (deps.log ?? ((l) => console.warn(JSON.stringify(l))))({ evt: "site_functions", step: "secret_unpush", outcome: "failed", site_id: input.site_id, name, error: (e as Error).message });
      }
    }
  }
  return { name, scope, deleted, applied };
}
