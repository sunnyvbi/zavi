
import { asTenantId, tenantClient } from "@/services/tenant-client";

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

export function buildRequestKeyFrom(header: unknown): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === "string" && KEY_RE.test(v) ? v : null;
}

export class DuplicateBuildRequest extends Error {
  constructor(readonly conductor_run_id: string) {
    super("this build request already started a build");
    this.name = "DuplicateBuildRequest";
  }
}

export async function stampBuildRequestKey(tenant_id: string, conductor_run_id: string, key: string): Promise<void> {
  const db = tenantClient(asTenantId(tenant_id));
  const { error } = await db.from("conductor_runs").update({ request_key: key }).eq("id", conductor_run_id);
  if (!error) return;
  if ((error as { code?: string }).code === "23505") {
    const { data } = await db.from("conductor_runs").select("id").eq("request_key", key).maybeSingle();
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id && id !== conductor_run_id) throw new DuplicateBuildRequest(id);
  }
  throw new Error(`could not record the build request key: ${error.message}`);
}
