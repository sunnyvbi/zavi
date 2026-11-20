
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export type GuardPlace = { id: string; name: string; kind: "Country" | "State" | "City" | "Zip" | "Region" | "Other"; platform: "meta" | "google" };
export type AdGuard = { allowed_places: GuardPlace[]; blocked_places: GuardPlace[]; banned_phrases: string[] };

export const EMPTY_AD_GUARD: AdGuard = { allowed_places: [], blocked_places: [], banned_phrases: [] };
export const AD_GUARD_MAX = 50;

export function asAdGuard(v: unknown): AdGuard {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return { allowed_places: list<GuardPlace>(o.allowed_places), blocked_places: list<GuardPlace>(o.blocked_places), banned_phrases: list<string>(o.banned_phrases).filter((p) => typeof p === "string") };
}

export const adGuardEmpty = (g: AdGuard) => g.allowed_places.length === 0 && g.blocked_places.length === 0 && g.banned_phrases.length === 0;

export async function readAdGuard(tenant_id: string): Promise<AdGuard> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenant_rule_settings").select("ad_guard").limit(1);
  if (error) throw new Error(`ad guard read failed: ${error.message}`);
  return asAdGuard(((data ?? []) as Array<{ ad_guard?: unknown }>)[0]?.ad_guard);
}

export async function saveAdGuard(tenant_id: string, actor: string, guard: AdGuard): Promise<AdGuard> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "rule_set_ad_guard", { p_actor: actor, p_guard: guard });
  if (error) throw new Error((error as { message?: string }).message ?? "save failed");
  return asAdGuard((data as { ad_guard?: unknown } | null)?.ad_guard);
}
