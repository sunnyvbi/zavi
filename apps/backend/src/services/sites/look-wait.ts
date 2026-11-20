import { BRAND_DIRECTION_ID, liveSwitchable } from "./design-directions";
import type { SiteDesignRow, SiteDesignStore } from "./site-design-store";

export const SITE_BUILD_WAITS_FOR_LOOK_SETTING = "site_build_waits_for_look" as const;

export const AWAITING_LOOK_GRAPH_MARKER = [{ status: "pending", payload: { await_look: true } }] as const;

type GraphNode = { status?: unknown; payload?: { await_look?: unknown; await_look_parked_at?: unknown; site_id?: unknown } | null };

export const LOOK_PARK_EXPIRY_MS = 30 * 60_000;

export const LOOK_PARKED_AT_KEY = "await_look_parked_at" as const;

export const LOOK_PARK_TIMED_OUT_REASON = "Waiting for your pick timed out. Start the build again and pick a website.";

export const LOOK_AUTO_START_MS = 60_000;

export function lookAutoStartAt(parked_at: string | null | undefined): string | null {
  const t = typeof parked_at === "string" ? Date.parse(parked_at) : NaN;
  return Number.isFinite(t) ? new Date(t + LOOK_AUTO_START_MS).toISOString() : null;
}

export function lookAutoStartDue(parked_at: string | null | undefined, now_ms: number): boolean {
  const at = lookAutoStartAt(parked_at);
  return at !== null && now_ms >= Date.parse(at);
}

export function recommendedLookId(row: Pick<SiteDesignRow, "directions">): string {
  return row.directions.find((d) => d?.recommended === true)?.id ?? BRAND_DIRECTION_ID;
}

export async function autoPickRecommendedLook(input: { tenant_id: string; site_id: string }): Promise<boolean> {
  const [{ asTenantId, tenantClient }, { siteDesignStore }] = await Promise.all([
    import("@/services/tenant-client"),
    import("./site-design-store"),
  ]);
  const row = await siteDesignStore().get(input.tenant_id, input.site_id);
  if (!rowAwaitsPick(row)) return false;
  const now = new Date().toISOString();
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("site_design_briefs")
    .update({ chosen_direction: recommendedLookId(row!), chosen_by: null, chosen_at: now, updated_at: now })
    .eq("site_id", input.site_id)
    .is("chosen_at", null)
    .is("sealed_at", null)
    .select("site_id");
  if (error) throw new Error(`auto look pick failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export function lookAwaitingSiteId(graph: unknown): string | null {
  if (!Array.isArray(graph)) return null;
  const first = (graph as GraphNode[]).find((n) => n?.status === "pending");
  if (!first || first.payload?.await_look !== true) return null;
  const site = first.payload.site_id;
  return typeof site === "string" && site.trim() ? site.trim() : null;
}

export function lookParkedAt(graph: unknown): string | null {
  if (!Array.isArray(graph)) return null;
  const first = (graph as GraphNode[]).find((n) => n?.status === "pending");
  if (!first || first.payload?.await_look !== true) return null;
  const at = first.payload[LOOK_PARKED_AT_KEY];
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
}

export function rowAwaitsPick(row: Pick<SiteDesignRow, "theme_mode" | "chosen_at" | "sealed_at" | "directions"> | null): boolean {
  return !!row && liveSwitchable(row.theme_mode) && row.chosen_at === null && row.sealed_at === null && Array.isArray(row.directions) && row.directions.length >= 2;
}

export async function siteAwaitsLook(
  store: Pick<SiteDesignStore, "get">,
  input: { tenant_id: string; site_id: string },
): Promise<boolean> {
  return rowAwaitsPick(await store.get(input.tenant_id, input.site_id));
}

export async function buildAwaitsLook(
  deps: { waitsForLook: (tenant_id: string) => Promise<boolean>; store: Pick<SiteDesignStore, "get"> },
  input: { tenant_id: string; site_id: string },
): Promise<boolean> {
  if ((await deps.waitsForLook(input.tenant_id)) !== true) return false;
  return siteAwaitsLook(deps.store, input);
}

export async function touchLookPickedRun(tenant_id: string, run_id: string): Promise<boolean> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", run_id)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export type LookParkState = "waiting" | "expired" | "picked" | "not_parked" | "ended" | "not_found";
export type LookParkCheck = { state: LookParkState; parked_at: string | null };

const PARK_STATES: ReadonlySet<string> = new Set(["waiting", "expired", "picked", "not_parked", "ended", "not_found"]);

export async function checkParkedLookRun(input: { tenant_id: string; conductor_run_id: string }): Promise<LookParkCheck> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(input.tenant_id), "expire_parked_look_run", {
    p_conductor_run_id: input.conductor_run_id,
    p_expiry_seconds: Math.round(LOOK_PARK_EXPIRY_MS / 1000),
  });
  if (error) throw new Error(`expire_parked_look_run failed: ${error.message}`);
  const out = (data ?? {}) as { state?: unknown; parked_at?: unknown };
  if (typeof out.state !== "string" || !PARK_STATES.has(out.state)) throw new Error("expire_parked_look_run returned no state");
  return { state: out.state as LookParkState, parked_at: typeof out.parked_at === "string" ? out.parked_at : null };
}

export async function pickParkedLook(input: { tenant_id: string; conductor_run_id: string; direction: string; user_id: string }): Promise<{ state: string }> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(input.tenant_id), "pick_parked_look", {
    p_conductor_run_id: input.conductor_run_id,
    p_direction: input.direction,
    p_user_id: input.user_id,
    p_expiry_seconds: Math.round(LOOK_PARK_EXPIRY_MS / 1000),
  });
  if (error) throw new Error(`pick_parked_look failed: ${error.message}`);
  const state = (data as { state?: unknown } | null)?.state;
  if (typeof state !== "string") throw new Error("pick_parked_look returned no state");
  return { state };
}
