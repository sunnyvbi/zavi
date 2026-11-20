
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { DesignBrief } from "./design-brief";
import type { FidelityResult } from "./design-fidelity";
import { BRAND_DIRECTION_ID, isStoredBrief, parseStoredDirections, type DesignDirection, type ThemeMode } from "./design-directions";
import type { JourneyFixClaim } from "./contract";

export type SiteDesignRow = {
  site_id: string;
  tenant_id: string;
  conductor_run_id: string;
  brief: DesignBrief;
  directions: DesignDirection[];
  theme_mode: ThemeMode;
  chosen_direction: string;
  chosen_at: string | null;
  applied_direction: string | null;
  build_direction?: string | null;
  sealed_at: string | null;
  journey_fix_claimed_at: string | null;
  journey_fix_conductor_run_id: string | null;
  fidelity: FidelityResult | null;
  updated_at: string | null;
};

export type SiteDesignStore = {
  get(tenant_id: string, site_id: string): Promise<SiteDesignRow | null>;
  createIfAbsent(row: {
    tenant_id: string;
    site_id: string;
    conductor_run_id: string;
    brief: DesignBrief;
    directions: DesignDirection[];
    theme_mode: ThemeMode;
  }): Promise<SiteDesignRow>;
  choose(tenant_id: string, site_id: string, direction: string, user_id: string | null): Promise<SiteDesignRow | null>;
  markApplied(tenant_id: string, site_id: string, direction: string): Promise<void>;
  seal(tenant_id: string, site_id: string): Promise<SiteDesignRow | null>;
  claimJourneyFix(tenant_id: string, site_id: string, conductor_run_id: string, attempt: number): Promise<JourneyFixClaim>;
  releaseJourneyFix(tenant_id: string, site_id: string, token: string): Promise<void>;
  recordFidelity(tenant_id: string, site_id: string, fidelity: FidelityResult, applied_direction: string | null): Promise<void>;
};

export function parseJourneyFixClaim(data: unknown): JourneyFixClaim {
  const d = data && typeof data === "object" ? (data as { status?: unknown; token?: unknown }) : null;
  const status = typeof d?.status === "string" ? d.status : null;
  if (status === "claimed") {
    return typeof d?.token === "string" && d.token ? { status: "claimed", token: d.token } : { status: "unavailable", reason: "claimed_without_token" };
  }
  if (status === "already_used") return { status: "already_used" };
  return { status: "unavailable", reason: status ?? "malformed" };
}

const COLUMNS =
  "site_id, tenant_id, conductor_run_id, brief, directions, theme_mode, chosen_direction, chosen_at, applied_direction, build_direction, sealed_at, journey_fix_claimed_at, journey_fix_conductor_run_id, fidelity, updated_at";
const THEME_MODES = new Set<ThemeMode>(["theme_css", "index_css", "none"]);

function toRow(raw: unknown): SiteDesignRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.site_id !== "string" || typeof r.tenant_id !== "string" || !isStoredBrief(r.brief)) return null;
  const mode = typeof r.theme_mode === "string" && THEME_MODES.has(r.theme_mode as ThemeMode) ? (r.theme_mode as ThemeMode) : "none";
  const fidelity = r.fidelity && typeof r.fidelity === "object" && Array.isArray((r.fidelity as FidelityResult).items) ? (r.fidelity as FidelityResult) : null;
  return {
    site_id: r.site_id,
    tenant_id: r.tenant_id,
    conductor_run_id: typeof r.conductor_run_id === "string" ? r.conductor_run_id : "",
    brief: r.brief,
    directions: parseStoredDirections(r.directions),
    theme_mode: mode,
    chosen_direction: typeof r.chosen_direction === "string" ? r.chosen_direction : BRAND_DIRECTION_ID,
    chosen_at: typeof r.chosen_at === "string" ? r.chosen_at : null,
    applied_direction: typeof r.applied_direction === "string" ? r.applied_direction : null,
    build_direction: typeof r.build_direction === "string" ? r.build_direction : null,
    sealed_at: typeof r.sealed_at === "string" ? r.sealed_at : null,
    journey_fix_claimed_at: typeof r.journey_fix_claimed_at === "string" ? r.journey_fix_claimed_at : null,
    journey_fix_conductor_run_id: typeof r.journey_fix_conductor_run_id === "string" ? r.journey_fix_conductor_run_id : null,
    fidelity,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

function table(tenant_id: string) {
  return tenantClient(asTenantId(tenant_id)).from("site_design_briefs");
}

export function siteDesignStore(): SiteDesignStore {
  const store: SiteDesignStore = {
    async get(tenant_id, site_id) {
      const { data, error } = await table(tenant_id).select(COLUMNS).eq("site_id", site_id).maybeSingle();
      if (error) throw new Error(`site design brief read failed: ${error.message}`);
      return toRow(data);
    },
    async createIfAbsent(row) {
      const { error } = await table(row.tenant_id).insert({
        site_id: row.site_id,
        conductor_run_id: row.conductor_run_id,
        brief: row.brief,
        directions: row.directions,
        theme_mode: row.theme_mode,
        chosen_direction: BRAND_DIRECTION_ID,
        applied_direction: row.theme_mode === "none" ? null : BRAND_DIRECTION_ID,
      });
      if (error && (error as { code?: string }).code !== "23505") throw new Error(`site design brief write failed: ${error.message}`);
      const stored = await store.get(row.tenant_id, row.site_id);
      if (!stored) throw new Error("site design brief write failed: the row is not readable");
      return stored;
    },
    async choose(tenant_id, site_id, direction, user_id) {
      const now = new Date().toISOString();
      const { data, error } = await table(tenant_id)
        .update({ chosen_direction: direction, chosen_by: user_id, chosen_at: now, updated_at: now })
        .eq("site_id", site_id)
        .is("sealed_at", null)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`site design pick failed: ${error.message}`);
      return toRow(data);
    },
    async markApplied(tenant_id, site_id, direction) {
      const now = new Date().toISOString();
      const { error } = await table(tenant_id)
        .update({ applied_direction: direction, applied_at: now, updated_at: now })
        .eq("site_id", site_id)
        .eq("chosen_direction", direction)
        .is("sealed_at", null);
      if (error) throw new Error(`site design apply mark failed: ${error.message}`);
    },
    async claimJourneyFix(tenant_id, site_id, conductor_run_id, attempt) {
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_brief_journey_fix_status", {
        p_site_id: site_id,
        p_conductor_run_id: conductor_run_id,
        p_attempt: attempt,
      });
      if (error) throw new Error(`brief journey fix claim failed: ${error.message}`);
      return parseJourneyFixClaim(data);
    },
    async releaseJourneyFix(tenant_id, site_id, token) {
      const { error } = await tenantRpc(asTenantId(tenant_id), "release_brief_journey_fix", {
        p_site_id: site_id,
        p_token: token,
      });
      if (error) throw new Error(`brief journey fix release failed: ${error.message}`);
    },
    async seal(tenant_id, site_id) {
      const now = new Date().toISOString();
      const { data, error } = await table(tenant_id)
        .update({ sealed_at: now, updated_at: now })
        .eq("site_id", site_id)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`site design seal failed: ${error.message}`);
      const row = toRow(data);
      if (row && row.theme_mode !== "none" && row.applied_direction !== row.chosen_direction) {
        const { error: markError } = await table(tenant_id)
          .update({ applied_direction: row.chosen_direction, applied_at: now })
          .eq("site_id", site_id)
          .eq("chosen_direction", row.chosen_direction);
        if (!markError) return { ...row, applied_direction: row.chosen_direction };
      }
      return row;
    },
    async recordFidelity(tenant_id, site_id, fidelity, applied_direction) {
      const now = new Date().toISOString();
      const { error } = await table(tenant_id)
        .update({
          fidelity,
          updated_at: now,
          ...(applied_direction ? { applied_direction, applied_at: now } : {}),
        })
        .eq("site_id", site_id);
      if (error) throw new Error(`site design fidelity write failed: ${error.message}`);
    },
  };
  return store;
}

export async function freezeBuildDirection(tenant_id: string, site_id: string, store: Pick<SiteDesignStore, "get"> = siteDesignStore()): Promise<SiteDesignRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await store.get(tenant_id, site_id);
    if (!row || row.build_direction) return row;
    const now = new Date().toISOString();
    const { data, error } = await table(tenant_id)
      .update({ build_direction: row.chosen_direction, build_direction_at: now })
      .eq("site_id", site_id)
      .eq("chosen_direction", row.chosen_direction)
      .is("build_direction", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`site design build direction write failed: ${error.message}`);
    const written = toRow(data);
    if (written) return written;
  }
  throw new Error("site design build direction write failed: the pick kept changing");
}
