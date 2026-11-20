
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { PushedFile } from "./app-db-on-demand";

export const METRICS_DECLARATION_PATH = "zavi-metrics.json";

export type DeclaredTable = { table: string; created_at: string };
export type MetricsDeclaration = {
  signups: DeclaredTable | null;
  business_event: DeclaredTable | null;
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function table(v: unknown): DeclaredTable | null {
  if (!v || typeof v !== "object") return null;
  const t = (v as Record<string, unknown>).table;
  const c = (v as Record<string, unknown>).created_at;
  if (typeof t !== "string" || typeof c !== "string") return null;
  if (!IDENT.test(t) || !IDENT.test(c)) return null;
  return { table: t, created_at: c };
}

export function parseMetricsDeclaration(files: ReadonlyArray<PushedFile>): MetricsDeclaration | undefined {
  const f = files.find(
    (x) =>
      typeof x?.path === "string" &&
      x.path.replace(/^\.?\//, "") === METRICS_DECLARATION_PATH &&
      x.action !== "delete",
  );
  if (!f || f.encoding === "base64" || typeof f.content !== "string" || !f.content) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(f.content);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return { signups: table(r.signups), business_event: table(r.business_event) };
}

export async function storeMetricsDeclaration(tenant_id: string, d: MetricsDeclaration): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .update({ metrics_declaration: d })
    .eq("resource_kind", "db");
  if (error) throw new Error(`metrics_declaration write failed: ${error.message}`);
}

export async function readMetricsDeclaration(tenant_id: string): Promise<MetricsDeclaration | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .select("metrics_declaration")
    .eq("resource_kind", "db")
    .maybeSingle<{ metrics_declaration: MetricsDeclaration | null }>();
  if (error) throw new Error(`metrics_declaration read failed: ${error.message}`);
  return data?.metrics_declaration ?? null;
}

export async function recordMetricsDeclaration(
  tenant_id: string,
  files: ReadonlyArray<PushedFile>,
  store: typeof storeMetricsDeclaration = storeMetricsDeclaration,
): Promise<void> {
  const d = parseMetricsDeclaration(files);
  if (!d) return;
  try {
    await store(tenant_id, d);
  } catch (e) {
    console.warn(`[metrics-declaration] tenant=${tenant_id} store failed: ${(e as Error).message}`);
  }
}
