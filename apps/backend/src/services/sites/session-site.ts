
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteRow } from "./contract";
import { SITE_MARKER_SELECT, rowHasSiteMarker, siteIdFromMarkerRow } from "./site-run";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BuildSessionApp =
  | { kind: "none" }
  | { kind: "old_flow"; run_id: string }
  | { kind: "site"; run_id: string; site: SiteRow };

export class BuildSessionError extends Error {
  constructor(
    readonly status: 400 | 404 | 503,
    readonly code: "invalid_build_session" | "build_session_not_found" | "build_session_check_failed",
    message: string,
  ) {
    super(message);
    this.name = "BuildSessionError";
  }
}

export type SessionSiteDeps = {
  getSiteByRun: (tenant_id: string, run_id: string) => Promise<SiteRow | null>;
  getSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
};

const defaultDeps: SessionSiteDeps = {
  getSiteByRun: async (tenant_id, run_id) => (await import("./store")).siteStore().getByRun(tenant_id, run_id),
  getSite: async (tenant_id, site_id) => (await import("./store")).siteStore().get(tenant_id, site_id),
};

export function buildSessionParam(req: Request): unknown {
  const q = (req.query as Record<string, unknown> | undefined)?.build_session_id;
  if (q !== undefined) return q;
  const b = (req.body as Record<string, unknown> | undefined)?.build_session_id;
  return b;
}

export async function resolveBuildSessionApp(
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
  raw: unknown,
  deps: SessionSiteDeps = defaultDeps,
): Promise<BuildSessionApp> {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "string" || !UUID_RE.test(raw.trim())) {
    throw new BuildSessionError(400, "invalid_build_session", "build_session_id must be a build id");
  }
  const run_id = raw.trim().toLowerCase();
  const { data, error } = await sb
    .from("conductor_runs")
    .select(`id, ${SITE_MARKER_SELECT}`)
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new BuildSessionError(503, "build_session_check_failed", `conductor_runs read failed: ${error.message}`);
  const row = data as { id?: unknown; s0?: unknown; s1?: unknown; s2?: unknown } | null;
  if (!row || typeof row.id !== "string" || row.id.toLowerCase() !== run_id) {
    throw new BuildSessionError(404, "build_session_not_found", "build session not found");
  }
  const markers = [row.s0, row.s1, row.s2].filter((v) => v !== null && v !== undefined);
  if (markers.some((v) => typeof v !== "string" || !UUID_RE.test(v))) {
    throw new BuildSessionError(404, "build_session_not_found", "build session not found");
  }
  if (!rowHasSiteMarker(row)) return { kind: "old_flow", run_id };
  let site: SiteRow | null;
  try {
    site = (await deps.getSiteByRun(tenant_id, run_id)) ?? null;
    if (!site) {
      const pointed = siteIdFromMarkerRow(row);
      site = pointed ? await deps.getSite(tenant_id, pointed) : null;
    }
  } catch (e) {
    throw new BuildSessionError(503, "build_session_check_failed", `sites read failed: ${(e as Error).message}`);
  }
  if (!site || site.tenant_id !== tenant_id) {
    throw new BuildSessionError(404, "build_session_not_found", "build session not found");
  }
  return { kind: "site", run_id, site };
}

export function sendBuildSessionError(res: Response, e: unknown): void {
  if (!(e instanceof BuildSessionError)) throw e;
  res.status(e.status).json({ error: { code: e.code, message: e.message } });
}
