import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { signTenantArtifactPaths, TTL_SECONDS } from "./file-url";
import { oldFlowBuiltApp, type OldFlowBuiltApp } from "@/services/run-artifacts/built-sites";
import {
  artifactKind,
  presentArtifact,
  readableThreadIds,
  type ArtifactKind,
  type ArtifactRow,
} from "@/services/run-artifacts/model";
import { siteStore } from "@/services/sites/store";
import { isVisibleSite, siteLiveUrl } from "@/services/sites/site-build-status";
import { siteShownName } from "@/services/sites/label";
import type { SiteRow, SiteStatus } from "@/services/sites/contract";
import { isSiteThumbnailPath } from "@/services/sites/site-thumbnail";
import { requestThumbnailHeals } from "@/services/sites/site-thumbnail-capture";

const MAX_ROWS = 500;

export type SiteArtifact = {
  id: string;
  title: string;
  hostname: string;
  status: SiteStatus;
  live_url: string | null;
  build_session_id: string | null;
  created_at: string;
  updated_at: string;
  built?: true;
  old_pipeline?: true;
  thumbnail_url?: string | null;
};

export function presentSiteArtifact(site: SiteRow): SiteArtifact {
  return {
    id: site.id,
    title: siteShownName(site),
    hostname: site.hostname,
    status: site.status,
    live_url: siteLiveUrl(site),
    build_session_id: site.root_conductor_run_id ?? null,
    created_at: site.created_at,
    updated_at: site.updated_at || site.created_at,
  };
}

export function presentOldFlowApp(app: OldFlowBuiltApp): SiteArtifact {
  const at = app.updated_at ?? "";
  return {
    id: "app:workspace",
    title: app.name,
    hostname: app.hostname ?? "",
    status: "live",
    live_url: app.live_url,
    build_session_id: app.build_run_id,
    created_at: at,
    updated_at: at,
    old_pipeline: true,
  };
}

const NOT_YET_PUBLISHED: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["provisioning", "building"]);

function thumbnailOf(site: SiteRow): string | null {
  return isSiteThumbnailPath(site.tenant_id, site.id, site.thumbnail_path) ? site.thumbnail_path : null;
}

async function markBuiltSites(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenantId: string,
  sites: SiteArtifact[],
): Promise<SiteArtifact[]> {
  const runIds = sites
    .filter((site) => NOT_YET_PUBLISHED.has(site.status) && site.build_session_id)
    .map((site) => site.build_session_id as string);
  if (runIds.length === 0) return sites;
  let data: unknown;
  try {
    const read = await sb.from("conductor_runs").select("id, status").eq("tenant_id", tenantId).in("id", runIds);
    if (read.error) return sites;
    data = read.data;
  } catch {
    return sites;
  }
  if (!Array.isArray(data)) return sites;
  const done = new Set(
    (data as Array<{ id: unknown; status: unknown }>).filter((r) => r.status === "done").map((r) => String(r.id)),
  );
  return sites.map((site) =>
    NOT_YET_PUBLISHED.has(site.status) && site.build_session_id && done.has(site.build_session_id)
      ? { ...site, built: true as const }
      : site,
  );
}

async function listSiteArtifacts(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenantId: string,
  query: string,
): Promise<SiteArtifact[]> {
  const [sites, app] = await Promise.all([
    siteStore()
      .listForTenant(tenantId)
      .then(async (rows) => {
        const own = rows.filter((site) => isVisibleSite(site) && site.tenant_id === tenantId);
        const byId = new Map(own.map((site) => [site.id, site]));
        const listed = await markBuiltSites(sb, tenantId, own.map(presentSiteArtifact));
        const paths = listed.map((site) => thumbnailOf(byId.get(site.id)!));
        const signed = await signTenantArtifactPaths(
          tenantId,
          paths.map((path) => ({ storagePath: path ?? "" })),
        ).catch(() => paths.map(() => null));
        const missing = listed.filter((site, i) => !paths[i] && (site.live_url || site.built)).map((site) => site.id);
        if (missing.length) void requestThumbnailHeals(tenantId, missing);
        return listed.map((site, i) => ({ ...site, thumbnail_url: paths[i] ? signed[i] ?? null : null }));
      })
      .catch((e: unknown) => {
        console.warn(`listRunArtifacts: sites read failed for tenant=${tenantId}: ${(e as Error)?.message ?? e}`);
        return [] as SiteArtifact[];
      }),
    oldFlowBuiltApp(tenantId).catch(() => null),
  ]);
  const all = app && !sites.some((site) => site.live_url === app.live_url) ? [...sites, presentOldFlowApp(app)] : sites;
  return query ? all.filter((site) => `${site.title}\n${site.hostname}`.toLocaleLowerCase("en-US").includes(query)) : all;
}
const ARTIFACT_TYPES = new Set<ArtifactKind>([
  "document",
  "spreadsheet",
  "image",
  "presentation",
  "website",
  "dashboard",
  "video",
  "file",
]);

function oneQueryValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function listRunArtifacts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const query = oneQueryValue(req.query?.q).slice(0, 120).toLocaleLowerCase("en-US");
  const channel = oneQueryValue(req.query?.channel).slice(0, 64);
  const requestedType = oneQueryValue(req.query?.type).toLocaleLowerCase("en-US");
  const type = ARTIFACT_TYPES.has(requestedType as ArtifactKind)
    ? requestedType as ArtifactKind
    : null;
  const sb = serverClientFromBearer(auth.access_token);
  const sitesRead: Promise<SiteArtifact[]> =
    channel || (type && type !== "website")
      ? Promise.resolve([])
      : listSiteArtifacts(sb, auth.tenant_id, query);

  let channelRunIds: string[] | null = null;
  if (channel) {
    const { data: runs, error: runErr } = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", auth.tenant_id)
      .eq("channel_slug", channel)
      .order("started_at", { ascending: false })
      .limit(MAX_ROWS);
    if (runErr) {
      res.status(500).json({
        error: { code: "artifact_list_failed", message: "Could not load artifacts." },
      });
      return;
    }
    channelRunIds = (Array.isArray(runs) ? runs : []).map((r) => String(r.id));
    if (channelRunIds.length === 0) {
      res.status(200).json({ artifacts: [], sites: [], expires_in: TTL_SECONDS });
      return;
    }
  }

  let q = sb
    .from("run_artifacts")
    .select("id, tenant_id, run_id, storage_path, bucket, filename, title, mime, bytes, created_at, updated_at, agent_slug, thread_id")
    .eq("tenant_id", auth.tenant_id);
  if (channelRunIds) q = q.in("run_id", channelRunIds);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    res.status(500).json({
      error: { code: "artifact_list_failed", message: "Could not load artifacts." },
    });
    return;
  }

  const rows = ((Array.isArray(data) ? data : []) as ArtifactRow[]).filter((row) => {
    if (type && artifactKind(row.mime, row.filename) !== type) return false;
    if (!query) return true;
    return `${row.title ?? ""}\n${row.filename}`.toLocaleLowerCase("en-US").includes(query);
  });

  const signed = await signTenantArtifactPaths(
    auth.tenant_id,
    rows.map((row) => ({ storagePath: row.storage_path, bucket: row.bucket })),
  );
  const readable = await readableThreadIds(sb, rows);
  const artifacts = rows.map((row, index) => presentArtifact(row, signed[index], readable));
  const sites = await sitesRead;

  res.status(200).json({ artifacts, sites, expires_in: TTL_SECONDS });
}
