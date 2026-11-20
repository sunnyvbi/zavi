
import { siteIdFromGraph } from "./site-run";
import type { SiteThumbnailStore } from "./site-thumbnail";

export const THUMBNAIL_READY_TIMEOUT_MS = 2 * 60_000;
export const THUMBNAIL_READY_POLL_MS = 5_000;
const HEAL_WINDOW_S = 60 * 60;
export const HEAL_TENANT_PER_HOUR = 6;
export const SITE_THUMBNAIL_EVENT = "site/thumbnail.requested" as const;

export type SiteThumbnailRequest =
  | { tenant_id: string; run_id: string }
  | { tenant_id: string; site_id: string; heal: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSiteThumbnailRequest(raw: unknown): SiteThumbnailRequest | null {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (typeof d.tenant_id !== "string" || !UUID_RE.test(d.tenant_id)) return null;
  if (d.heal === true && typeof d.site_id === "string" && UUID_RE.test(d.site_id)) return { tenant_id: d.tenant_id, site_id: d.site_id, heal: true };
  if (typeof d.run_id === "string" && UUID_RE.test(d.run_id)) return { tenant_id: d.tenant_id, run_id: d.run_id };
  return null;
}

export function runThumbnailEvent(tenant_id: string, run_id: string) {
  return { id: `site-thumbnail-${run_id}`, name: SITE_THUMBNAIL_EVENT, data: { tenant_id, run_id } };
}

export function healThumbnailEvent(tenant_id: string, site_id: string, nowMs: number = Date.now()) {
  const hour = Math.floor(nowMs / 3_600_000);
  return { id: `site-thumbnail-heal-${site_id}-${hour}`, name: SITE_THUMBNAIL_EVENT, data: { tenant_id, site_id, heal: true as const } };
}

export async function requestThumbnailHeals(tenant_id: string, site_ids: string[]): Promise<void> {
  const ids = site_ids.filter((id) => UUID_RE.test(id)).slice(0, 20);
  if (!ids.length || !UUID_RE.test(tenant_id)) return;
  try {
    const { inngest } = await import("../../../workers/client");
    await inngest.send(ids.map((id) => healThumbnailEvent(tenant_id, id)));
  } catch (e) {
    console.warn(`[site-thumbnail] heal request failed tenant=${tenant_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

export type SiteThumbnailTarget = { previewUrl: string | null; liveUrl: string | null; hasThumbnail: boolean };

export type BuildThumbnailOutcome =
  | { status: "saved" }
  | { status: "skipped"; reason: string };

export type BuildThumbnailDeps = {
  claimHeal: (tenantId: string, siteId: string) => Promise<boolean>;
  loadRun: (tenantId: string, runId: string) => Promise<{ goal_graph: unknown; status: string | null } | null>;
  siteTarget: (tenantId: string, siteId: string) => Promise<SiteThumbnailTarget | null>;
  probe: (origin: string) => Promise<boolean>;
  capture: (input: { preview_url: string; tenant_id: string; site_id: string }) => Promise<string | null>;
  thumbnails: SiteThumbnailStore;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
};

function publishesItself(graph: unknown): boolean {
  return Array.isArray(graph) && (graph as Array<{ payload?: { stage?: unknown } }>).some((n) => n?.payload?.stage === "deploy");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function realDeps(): Promise<BuildThumbnailDeps> {
  const [{ asTenantId, consumeTenantRateLimit, tenantClient }, { siteStore }, { loadSiteSandboxPreview, siteLiveUrl }, { probeSandboxDevServer }, { captureHomeScreenshot }, { siteThumbnailStore }] =
    await Promise.all([
      import("@/services/tenant-client"),
      import("./store"),
      import("./site-build-status"),
      import("@/services/sandbox/preview-ready-probe"),
      import("./site-gate"),
      import("./site-thumbnail"),
    ]);
  return {
    claimHeal: async (tenantId, siteId) =>
      (await consumeTenantRateLimit(asTenantId(tenantId), "site_thumbnail_heal_tenant", HEAL_TENANT_PER_HOUR, HEAL_WINDOW_S)) &&
      (await consumeTenantRateLimit(asTenantId(tenantId), `site_thumbnail_heal:${siteId}`, 1, HEAL_WINDOW_S)),
    loadRun: async (tenantId, runId) => {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("conductor_runs")
        .select("goal_graph, status")
        .eq("tenant_id", tenantId)
        .eq("id", runId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { goal_graph?: unknown; status?: string | null } | null;
      return row ? { goal_graph: row.goal_graph ?? null, status: row.status ?? null } : null;
    },
    siteTarget: async (tenantId, siteId) => {
      const site = await siteStore().get(tenantId, siteId);
      if (!site || site.status === "deleting" || site.status === "deleted") return null;
      const row = site.github_full_name ? await loadSiteSandboxPreview(tenantId, site.github_full_name) : null;
      return {
        previewUrl: row?.preview_status === "dead" ? null : (row?.preview_url ?? null),
        liveUrl: siteLiveUrl(site),
        hasThumbnail: !!site.thumbnail_path,
      };
    },
    probe: (origin) => probeSandboxDevServer(origin),
    capture: (input) => captureHomeScreenshot(input),
    thumbnails: siteThumbnailStore(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

const REQUIRED = ["claimHeal", "loadRun", "siteTarget", "probe", "capture", "thumbnails", "sleep", "now"] as const;

async function resolveDeps(partial?: Partial<BuildThumbnailDeps>): Promise<BuildThumbnailDeps> {
  const supplied = partial ?? {};
  return REQUIRED.every((k) => supplied[k] !== undefined) ? (supplied as BuildThumbnailDeps) : { ...(await realDeps()), ...supplied };
}

export type ThumbnailTenantOf = (req: { run_id: string } | { site_id: string }) => Promise<string | null>;

export async function handleSiteThumbnailRequest(
  raw: unknown,
  tenantOf: ThumbnailTenantOf,
  partial?: Partial<BuildThumbnailDeps>,
): Promise<BuildThumbnailOutcome> {
  const req = parseSiteThumbnailRequest(raw);
  if (!req) return { status: "skipped", reason: "bad_request" };
  const owner = await tenantOf("heal" in req ? { site_id: req.site_id } : { run_id: req.run_id });
  if (!owner) return { status: "skipped", reason: "not_found" };
  if (owner.toLowerCase() !== req.tenant_id.toLowerCase()) {
    console.warn(`[site-thumbnail] dropped request: payload tenant does not own ${"heal" in req ? `site ${req.site_id}` : `run ${req.run_id}`}`);
    return { status: "skipped", reason: "tenant_mismatch" };
  }
  return "heal" in req
    ? healSiteThumbnail({ tenantId: owner, siteId: req.site_id }, partial)
    : captureBuildThumbnail({ tenantId: owner, runId: req.run_id }, partial);
}

export async function healSiteThumbnail(
  input: { tenantId: string; siteId: string },
  partial?: Partial<BuildThumbnailDeps>,
): Promise<BuildThumbnailOutcome> {
  const where = `tenant=${input.tenantId} site=${input.siteId} heal`;
  const skip = (reason: string, log = false): BuildThumbnailOutcome => {
    if (log) console.warn(`[site-thumbnail] skipped ${where} reason=${reason}`);
    return { status: "skipped", reason };
  };
  const deps = await resolveDeps(partial);
  const target = await deps.siteTarget(input.tenantId, input.siteId);
  if (!target) return skip("no_site");
  if (target.hasThumbnail) return skip("has_thumbnail");
  if (!(await deps.claimHeal(input.tenantId, input.siteId))) return skip("over_budget");
  const previewOrigin = target.previewUrl ? originOf(target.previewUrl) : null;
  const live = previewOrigin && (await deps.probe(previewOrigin).catch(() => false)) ? target.previewUrl : null;
  const url = live ?? target.liveUrl;
  if (!url || !originOf(url)) return skip("nothing_to_screenshot", true);
  const taken_at = new Date(deps.now());
  const shot = await deps.capture({ preview_url: url, tenant_id: input.tenantId, site_id: input.siteId });
  if (!shot) return skip("no_clean_screenshot", true);
  const saved = await deps.thumbnails.save({ tenant_id: input.tenantId, site_id: input.siteId, jpeg_b64: shot, taken_at });
  return saved ? { status: "saved" } : skip("not_stored");
}

export async function captureBuildThumbnail(
  input: { tenantId: string; runId: string },
  partial?: Partial<BuildThumbnailDeps>,
): Promise<BuildThumbnailOutcome> {
  const where = `tenant=${input.tenantId} run=${input.runId}`;
  const skip = (reason: string, log = false): BuildThumbnailOutcome => {
    if (log) console.warn(`[site-thumbnail] skipped ${where} reason=${reason}`);
    return { status: "skipped", reason };
  };
  const deps = await resolveDeps(partial);
  const run = await deps.loadRun(input.tenantId, input.runId);
  if (!run) return skip("no_run");
  if (publishesItself(run.goal_graph)) return skip("publishes_itself");
  const siteId = siteIdFromGraph(run.goal_graph);
  if (!siteId) return skip("not_a_site_build");
  if (run.status !== "done") return skip(`run_${run.status ?? "unknown"}`);

  const url = (await deps.siteTarget(input.tenantId, siteId))?.previewUrl ?? null;
  const origin = url ? originOf(url) : null;
  if (!url || !origin) return skip("no_preview", true);
  const timeout = deps.readyTimeoutMs ?? THUMBNAIL_READY_TIMEOUT_MS;
  const poll = deps.readyPollMs ?? THUMBNAIL_READY_POLL_MS;
  const started = deps.now();
  while (!(await deps.probe(origin).catch(() => false))) {
    if (deps.now() - started >= timeout) return skip("preview_not_ready", true);
    await deps.sleep(poll);
  }
  const taken_at = new Date(deps.now());
  const shot = await deps.capture({ preview_url: url, tenant_id: input.tenantId, site_id: siteId });
  if (!shot) return skip("no_clean_screenshot", true);
  const saved = await deps.thumbnails.save({ tenant_id: input.tenantId, site_id: siteId, jpeg_b64: shot, taken_at });
  return saved ? { status: "saved" } : skip("not_stored");
}
