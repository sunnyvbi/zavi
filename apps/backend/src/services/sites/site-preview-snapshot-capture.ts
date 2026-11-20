import { siteIdFromGraph } from "./site-run";
import type { SitePreviewSnapshotStore } from "./site-preview-snapshot";

export const SITE_PREVIEW_SNAPSHOT_EVENT = "site/preview-snapshot.requested" as const;
export const SNAPSHOT_READY_TIMEOUT_MS = 2 * 60_000;
export const SNAPSHOT_READY_POLL_MS = 5_000;
export const SNAPSHOT_TENANT_PER_HOUR = 30;
const SNAPSHOT_WINDOW_S = 60 * 60;

export type SitePreviewSnapshotRequest = { tenant_id: string; site_id: string; deferred?: number };

export const SNAPSHOT_BUILD_DEFERS = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSitePreviewSnapshotRequest(raw: unknown): SitePreviewSnapshotRequest | null {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (typeof d.tenant_id !== "string" || !UUID_RE.test(d.tenant_id)) return null;
  if (typeof d.site_id !== "string" || !UUID_RE.test(d.site_id)) return null;
  const deferred = typeof d.deferred === "number" && Number.isInteger(d.deferred) && d.deferred > 0 ? Math.min(d.deferred, SNAPSHOT_BUILD_DEFERS) : 0;
  return { tenant_id: d.tenant_id, site_id: d.site_id, ...(deferred ? { deferred } : {}) };
}

export function sitePreviewSnapshotEvent(input: SitePreviewSnapshotRequest) {
  return {
    name: SITE_PREVIEW_SNAPSHOT_EVENT,
    data: { tenant_id: input.tenant_id, site_id: input.site_id, ...(input.deferred ? { deferred: input.deferred } : {}) },
  };
}

export type SnapshotOutcome = { status: "saved"; devices: string[] } | { status: "skipped"; reason: string };

export type SnapshotCaptureDeps = {
  claim: (tenantId: string) => Promise<boolean>;
  loadRun: (tenantId: string, runId: string) => Promise<{ goal_graph: unknown; status: string | null } | null>;
  previewUrl: (tenantId: string, siteId: string) => Promise<string | null | undefined>;
  hasActiveBuild: (tenantId: string) => Promise<boolean>;
  probe: (origin: string) => Promise<boolean>;
  treeState?: (tenantId: string, siteId: string) => Promise<"same" | "stale" | "unknown">;
  capture: (input: { preview_url: string; tenant_id: string; site_id: string }) => Promise<{ desktop: string; mobile: string | null } | null>;
  snapshots: SitePreviewSnapshotStore;
  send: (event: ReturnType<typeof sitePreviewSnapshotEvent>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
};

export type SnapshotTenantOf = (req: { site_id: string }) => Promise<string | null>;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function why(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}

async function realDeps(): Promise<SnapshotCaptureDeps> {
  const [{ asTenantId, consumeTenantRateLimit, tenantClient }, { siteStore }, { loadSiteSandboxPreview }, { probeSandboxDevServer }, { capturePreviewSnapshots }, { sitePreviewSnapshotStore }] =
    await Promise.all([
      import("@/services/tenant-client"),
      import("./store"),
      import("./site-build-status"),
      import("@/services/sandbox/preview-ready-probe"),
      import("./site-gate"),
      import("./site-preview-snapshot"),
    ]);
  return {
    claim: (tenantId) => consumeTenantRateLimit(asTenantId(tenantId), "site_preview_snapshot_tenant", SNAPSHOT_TENANT_PER_HOUR, SNAPSHOT_WINDOW_S),
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
    previewUrl: async (tenantId, siteId) => {
      const site = await siteStore().get(tenantId, siteId);
      if (!site || site.status === "deleting" || site.status === "deleted") return undefined;
      const row = site.github_full_name ? await loadSiteSandboxPreview(tenantId, site.github_full_name) : null;
      return row?.preview_status === "dead" ? null : (row?.preview_url ?? null);
    },
    hasActiveBuild: async (tenantId) => {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("conductor_runs")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("kind", "build_app")
        .in("status", ["active", "provisioning"])
        .limit(1);
      if (error) throw new Error(error.message);
      return ((data as unknown[] | null)?.length ?? 0) > 0;
    },
    probe: (origin) => probeSandboxDevServer(origin),
    treeState: async (tenantId, siteId) => {
      const site = await siteStore().get(tenantId, siteId);
      const repo = (site?.github_full_name ?? "").trim();
      if (!repo) return "unknown";
      const { data, error } = await (tenantClient(asTenantId(tenantId)).from("tenant_sandbox").select("e2b_sandbox_id") as any)
        .eq("repo_full_name", repo)
        .maybeSingle();
      const sandbox_id = (data as { e2b_sandbox_id?: string | null } | null)?.e2b_sandbox_id ?? null;
      if (error || !sandbox_id) return "unknown";
      const { previewTreeState } = await import("./site-preview-wake");
      const tree = await previewTreeState(
        { sandbox_id, repo_full_name: repo },
        {
          headTree: async (r) => (await import("@/services/provisioning/github-repo")).readProvisionedRepoHeadTree(r, "main"),
          exec: async (id, cmd, t) => (await import("@/services/sandbox/e2b-client")).execCommand(id, cmd, t),
        },
      );
      return tree.state;
    },
    capture: (input) => capturePreviewSnapshots(input),
    snapshots: sitePreviewSnapshotStore(),
    send: async (event) => (await import("../../../workers/client")).inngest.send(event),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

const REQUIRED = ["claim", "loadRun", "previewUrl", "hasActiveBuild", "probe", "capture", "snapshots", "send", "sleep", "now"] as const;

async function resolveDeps(partial?: Partial<SnapshotCaptureDeps>): Promise<SnapshotCaptureDeps> {
  const supplied = partial ?? {};
  return REQUIRED.every((k) => supplied[k] !== undefined) ? (supplied as SnapshotCaptureDeps) : { ...(await realDeps()), ...supplied };
}

export async function handleSitePreviewSnapshotRequest(
  raw: unknown,
  tenantOf: SnapshotTenantOf,
  partial?: Partial<SnapshotCaptureDeps>,
): Promise<SnapshotOutcome> {
  const req = parseSitePreviewSnapshotRequest(raw);
  if (!req) return { status: "skipped", reason: "bad_request" };
  const owner = await tenantOf({ site_id: req.site_id });
  if (!owner) return { status: "skipped", reason: "not_found" };
  if (owner.toLowerCase() !== req.tenant_id.toLowerCase()) {
    console.warn(`[site-preview-snapshot] dropped request: payload tenant does not own site ${req.site_id}`);
    return { status: "skipped", reason: "tenant_mismatch" };
  }
  return captureSitePreviewSnapshot({ tenantId: owner, siteId: req.site_id, deferred: req.deferred ?? 0 }, await resolveDeps(partial));
}

export async function captureSitePreviewSnapshot(
  input: { tenantId: string; siteId: string; deferred?: number },
  deps: SnapshotCaptureDeps,
): Promise<SnapshotOutcome> {
  const where = `tenant=${input.tenantId} site=${input.siteId}`;
  const skip = (reason: string, log = false): SnapshotOutcome => {
    if (log) console.warn(`[site-preview-snapshot] skipped ${where} reason=${reason}`);
    return { status: "skipped", reason };
  };
  const deferForBuild = async (): Promise<SnapshotOutcome> => {
    const deferred = input.deferred ?? 0;
    if (deferred >= SNAPSHOT_BUILD_DEFERS) return skip("build_active", true);
    await deps.send(sitePreviewSnapshotEvent({ tenant_id: input.tenantId, site_id: input.siteId, deferred: deferred + 1 })).catch((e: unknown) => {
      console.warn(`[site-preview-snapshot] deferral failed ${where}: ${why(e)}`);
    });
    return skip("build_active_deferred");
  };
  if (await deps.hasActiveBuild(input.tenantId)) return deferForBuild();
  const url = await deps.previewUrl(input.tenantId, input.siteId);
  if (url === undefined) return skip("no_site");
  const origin = url ? originOf(url) : null;
  if (!url || !origin) return skip("no_preview");
  if (!(await deps.claim(input.tenantId))) return skip("over_budget", true);
  const timeout = deps.readyTimeoutMs ?? SNAPSHOT_READY_TIMEOUT_MS;
  const poll = deps.readyPollMs ?? SNAPSHOT_READY_POLL_MS;
  const started = deps.now();
  while (!(await deps.probe(origin).catch(() => false))) {
    if (deps.now() - started >= timeout) return skip("preview_not_ready", true);
    await deps.sleep(poll);
  }
  if (deps.treeState) {
    const tree = await deps.treeState(input.tenantId, input.siteId).catch(() => "unknown" as const);
    if (tree !== "same") return skip(`preview_tree_${tree}`, true);
  }
  const taken_at = new Date(deps.now());
  const shots = await deps.capture({ preview_url: url, tenant_id: input.tenantId, site_id: input.siteId });
  if (!shots) return skip("no_clean_screenshot", true);
  if (await deps.hasActiveBuild(input.tenantId)) return deferForBuild();
  const devices: string[] = [];
  if (await deps.snapshots.save({ tenant_id: input.tenantId, site_id: input.siteId, device: "desktop", jpeg_b64: shots.desktop, taken_at })) devices.push("desktop");
  if (shots.mobile && (await deps.snapshots.save({ tenant_id: input.tenantId, site_id: input.siteId, device: "mobile", jpeg_b64: shots.mobile, taken_at }))) devices.push("mobile");
  return devices.length ? { status: "saved", devices } : skip("not_stored");
}

export async function notePreviewChanged(tenant_id: string, site_id: string, partial?: Partial<SnapshotCaptureDeps>): Promise<void> {
  if (!parseSitePreviewSnapshotRequest({ tenant_id, site_id })) return;
  const deps = await resolveDeps(partial).catch(() => null);
  if (!deps) return;
  try {
    await deps.snapshots.markChanged(tenant_id, site_id);
  } catch (e) {
    console.warn(`[site-preview-snapshot] ALERT change mark failed tenant=${tenant_id} site=${site_id}: ${why(e)}`);
  }
  await deps.send(sitePreviewSnapshotEvent({ tenant_id, site_id })).catch((e: unknown) => {
    console.warn(`[site-preview-snapshot] request failed tenant=${tenant_id} site=${site_id}: ${why(e)}`);
  });
}

export async function noteRunPreviewChanged(tenant_id: string, run_id: string, partial?: Partial<SnapshotCaptureDeps>): Promise<void> {
  const deps = await resolveDeps(partial).catch(() => null);
  if (!deps) return;
  let siteId: string | null = null;
  try {
    const run = await deps.loadRun(tenant_id, run_id);
    siteId = run ? siteIdFromGraph(run.goal_graph) : null;
  } catch (e) {
    console.warn(`[site-preview-snapshot] ALERT run read failed tenant=${tenant_id} run=${run_id}: ${why(e)}`);
  }
  if (siteId) await notePreviewChanged(tenant_id, siteId, deps);
}
