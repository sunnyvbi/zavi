
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { platformConnectorSlugs } from "@/services/connectors/platform-slugs";

export const READ_SLOW_MS = 3 * 3_600_000;

export type LoginProblem = { since: string; kind: "auth" | "account_gone" };

export type AdReadFailures = { reconnect: Map<string, LoginProblem>; slow: Map<string, string> };

export const RECONNECT_RECHECK_MS = 2 * 3_600_000;

export function loginFailureFixed(
  since: string,
  connectedAts: ReadonlyArray<string | null | undefined>,
  now: number,
): boolean {
  const connected = Math.max(...connectedAts.map((c) => (c ? Date.parse(c) : NaN)).filter(Number.isFinite));
  const began = Date.parse(since);
  if (!Number.isFinite(connected) || !Number.isFinite(began) || began >= connected) return false;
  return now - connected < RECONNECT_RECHECK_MS;
}

export async function readConnectedAt(tenant_id: string): Promise<Map<string, string>> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .select("slug, connected_at")
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ slug: string; connected_at: string | null }>) if (r.connected_at) out.set(r.slug, r.connected_at);
  return out;
}

export async function readAdReadFailures(tenant_id: string, now = Date.now()): Promise<AdReadFailures> {
  const out: AdReadFailures = { reconnect: new Map(), slow: new Map() };
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_budgets")
      .select("read_failed, read_failure_kinds")
      .eq("tenant_id", tenant_id)
      .eq("status", "active");
    if (error) return out;
    const rows = (data ?? []) as Array<{ read_failed: Record<string, string> | null; read_failure_kinds?: Record<string, string> | null }>;
    const anyLogin = rows.some((r) => Object.keys(r.read_failed ?? {}).some((p) => ["auth", "account_gone"].includes(r.read_failure_kinds?.[p] ?? "")));
    const connectedAt = anyLogin ? await readConnectedAt(tenant_id).catch(() => new Map<string, string>()) : new Map<string, string>();
    for (const row of rows) {
      for (const [platform, since] of Object.entries(row.read_failed ?? {})) {
        if (typeof since !== "string" || !since) continue;
        const kind = row.read_failure_kinds?.[platform];
        if (kind === "disconnected") continue;
        const login = kind === "auth" || kind === "account_gone";
        if (!login && !(now - Date.parse(since) >= READ_SLOW_MS)) continue;
        const slugs = platformConnectorSlugs(platform);
        if (login && loginFailureFixed(since, slugs.map((sl) => connectedAt.get(sl)), now)) continue;
        for (const slug of slugs) {
          if (login) {
            const had = out.reconnect.get(slug);
            if (!had || since < had.since) out.reconnect.set(slug, { since, kind });
          } else {
            const had = out.slow.get(slug);
            if (!had || since < had) out.slow.set(slug, since);
          }
        }
      }
    }
    for (const slug of out.reconnect.keys()) out.slow.delete(slug);
  } catch {
  }
  return out;
}
