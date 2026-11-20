import { runPreviewScan, type PreviewScanInput, type PreviewScanResult } from "./site-gate";
import { siteIdFromGraph } from "./site-run";

export const PREVIEW_CHECK_FLAG = "SITE_PREVIEW_CHECK";
export const PREVIEW_READY_TIMEOUT_MS = 3 * 60_000;
export const PREVIEW_READY_POLL_MS = 5_000;
export const PREVIEW_FIX_TIMEOUT_MS = 20 * 60_000;
export const PREVIEW_FIX_POLL_MS = 15_000;
const ONCE_WINDOW_S = 30 * 24 * 60 * 60;
const REASON_MAX = 300;
const RUNNING = new Set(["active", "provisioning", "pending", "queued"]);

export function previewCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PREVIEW_CHECK_FLAG] === "1";
}

export type PreviewCheckInput = {
  tenantId: string;
  runId: string;
  siteId?: string | null;
  previewUrl?: string | null;
};

export type PreviewCheckOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | { status: "clean" }
  | { status: "unscannable"; reason: string }
  | { status: "fix_not_started"; reason: string }
  | { status: "fix_failed"; reason: string }
  | { status: "fixed"; fix_run_id: string }
  | { status: "still_erroring"; fix_run_id: string; reason: string };

export type PreviewCheckRun = { goal_graph: unknown; status: string | null };
export type PreviewSite = { previewUrl: string | null; siteName: string | null };

export type PreviewCheckDeps = {
  env?: NodeJS.ProcessEnv;
  claimOnce: (tenantId: string, runId: string) => Promise<boolean>;
  loadRun: (tenantId: string, runId: string) => Promise<PreviewCheckRun | null>;
  loadSite: (tenantId: string, siteId: string) => Promise<PreviewSite | null>;
  probe: (origin: string) => Promise<boolean>;
  scan: (input: PreviewScanInput) => Promise<PreviewScanResult>;
  startFixPass: (input: { tenantId: string; runId: string; siteId: string; message: string }) => Promise<{ runId: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  fixTimeoutMs?: number;
  fixPollMs?: number;
};

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, REASON_MAX);
}

function isRefine(graph: unknown): boolean {
  return Array.isArray(graph) && (graph as Array<{ payload?: { refine_mode?: unknown } }>)[0]?.payload?.refine_mode === true;
}

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

export function previewFixMessage(reason: string): string {
  return (
    `The site's preview shows an error to visitors: ${reason.slice(0, REASON_MAX)}\n` +
    "Find what causes it and fix the site so every page renders its real content with no error message. Keep the design and content as they are."
  );
}

async function realDeps(): Promise<PreviewCheckDeps> {
  const [{ asTenantId, consumeTenantRateLimit, tenantClient }, { siteStore }, { loadSiteSandboxPreview }, { probeSandboxDevServer }] =
    await Promise.all([
      import("@/services/tenant-client"),
      import("./store"),
      import("./site-build-status"),
      import("@/services/sandbox/preview-ready-probe"),
    ]);
  return {
    claimOnce: (tenantId, runId) => consumeTenantRateLimit(asTenantId(tenantId), `preview_check:${runId}`, 1, ONCE_WINDOW_S),
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
    loadSite: async (tenantId, siteId) => {
      const site = await siteStore().get(tenantId, siteId);
      if (!site) return null;
      const row = site.github_full_name ? await loadSiteSandboxPreview(tenantId, site.github_full_name) : null;
      return { previewUrl: row?.preview_status === "dead" ? null : row?.preview_url ?? null, siteName: site.name ?? null };
    },
    probe: (origin) => probeSandboxDevServer(origin),
    scan: (input) => runPreviewScan(input),
    startFixPass: async ({ tenantId, runId, message }) => {
      const [{ refineProduct }, { requestConductorTick }, { inngest }, { sanitizeFetchedContent, xmlEscapeContent }] = await Promise.all([
        import("@/services/agents/refine-product"),
        import("@/services/agents/conductor-kick"),
        import("../../../workers/client"),
        import("@/services/onboarding/enrichment/sanitize"),
      ]);
      const r = await refineProduct({
        tenant_id: tenantId,
        message: xmlEscapeContent(sanitizeFetchedContent(message)),
        conductor_run_id: runId,
      });
      await requestConductorTick(inngest, r.conductor_run_id);
      return { runId: r.conductor_run_id };
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

const REQUIRED_DEPS = ["claimOnce", "loadRun", "loadSite", "probe", "scan", "startFixPass", "sleep", "now"] as const;

export async function runPreviewCheck(input: PreviewCheckInput, partial?: Partial<PreviewCheckDeps>): Promise<PreviewCheckOutcome> {
  const env = partial?.env ?? process.env;
  if (!previewCheckEnabled(env)) return { status: "disabled" };
  let where = `tenant=${input.tenantId} run=${input.runId}`;
  const log = (event: string, extra = "") => console.warn(`[preview-check] event=${event} ${where}${extra ? ` ${extra}` : ""}`);
  try {
    const supplied = partial ?? {};
    const complete = REQUIRED_DEPS.every((k) => typeof supplied[k] === "function");
    const deps: PreviewCheckDeps = complete ? (supplied as PreviewCheckDeps) : { ...(await realDeps()), ...supplied };
    return await check(input, deps, log, (site) => {
      where = `tenant=${input.tenantId} site=${site} run=${input.runId}`;
    });
  } catch (e) {
    log("error", `reason=${JSON.stringify(msg(e))}`);
    return { status: "skipped", reason: "error" };
  }
}

type Log = (event: string, extra?: string) => void;

async function check(input: PreviewCheckInput, deps: PreviewCheckDeps, log: Log, setSite: (site: string) => void): Promise<PreviewCheckOutcome> {
  const skip = (reason: string): PreviewCheckOutcome => {
    log("skipped", `reason=${reason}`);
    return { status: "skipped", reason };
  };
  const run = await deps.loadRun(input.tenantId, input.runId);
  if (!run) return skip("no_run");
  if (isRefine(run.goal_graph)) return { status: "skipped", reason: "edit_run" };
  if (publishesItself(run.goal_graph)) return { status: "skipped", reason: "publishes_itself" };
  const siteId = input.siteId ?? siteIdFromGraph(run.goal_graph);
  if (!siteId) return { status: "skipped", reason: "not_a_site_build" };
  setSite(siteId);
  if (run.status !== "done") return skip(`run_${run.status ?? "unknown"}`);
  if (!(await deps.claimOnce(input.tenantId, input.runId).catch(() => false))) return skip("already_checked");

  const site = await deps.loadSite(input.tenantId, siteId);
  const firstUrl = input.previewUrl ?? site?.previewUrl ?? null;
  if (!firstUrl) return skip("no_preview");

  const first = await readyThenScan(firstUrl, input, siteId, site?.siteName ?? null, deps, log);
  if (first.kind === "not_ready") return skip("still_compiling");
  if (first.kind === "unscannable") {
    log("unscannable", `reason=${JSON.stringify(first.reason)}`);
    return { status: "unscannable", reason: first.reason };
  }
  if (first.kind === "clean") {
    log("clean", `routes=${first.routes.length}`);
    return { status: "clean" };
  }
  log("errors", `reason=${JSON.stringify(first.reason)}`);

  let fixRunId: string;
  try {
    fixRunId = (await deps.startFixPass({ tenantId: input.tenantId, runId: input.runId, siteId, message: previewFixMessage(first.reason) })).runId;
  } catch (e) {
    const reason = `${(e as Error)?.name ?? "Error"}: ${msg(e)}`;
    log("fix_not_started", `reason=${JSON.stringify(reason)}`);
    return { status: "fix_not_started", reason };
  }
  log("fix_started", `fix_run=${fixRunId}`);

  const ended = await waitForRun(fixRunId, input.tenantId, deps);
  if (ended !== "done") {
    const reason = ended === null ? "timed_out" : `run_${ended}`;
    log("fix_failed", `fix_run=${fixRunId} reason=${reason}`);
    return { status: "fix_failed", reason };
  }

  const after = await deps.loadSite(input.tenantId, siteId).catch(() => null);
  const second = await readyThenScan(after?.previewUrl ?? firstUrl, input, siteId, after?.siteName ?? site?.siteName ?? null, deps, log);
  if (second.kind === "clean") {
    log("fixed", `fix_run=${fixRunId}`);
    return { status: "fixed", fix_run_id: fixRunId };
  }
  if (second.kind === "errors") {
    log("still_erroring", `fix_run=${fixRunId} reason=${JSON.stringify(second.reason)}`);
    return { status: "still_erroring", fix_run_id: fixRunId, reason: second.reason };
  }
  const reason = second.kind === "not_ready" ? "still_compiling" : second.reason;
  log("rescan_skipped", `fix_run=${fixRunId} reason=${JSON.stringify(reason)}`);
  return { status: "unscannable", reason };
}

type ScanOutcome = PreviewScanResult | { kind: "not_ready" };

async function readyThenScan(
  url: string,
  input: PreviewCheckInput,
  siteId: string,
  siteName: string | null,
  deps: PreviewCheckDeps,
  log: Log,
): Promise<ScanOutcome> {
  const origin = originOf(url);
  if (!origin) return { kind: "unscannable", reason: "the preview address is not a URL" };
  const timeout = deps.readyTimeoutMs ?? PREVIEW_READY_TIMEOUT_MS;
  const poll = deps.readyPollMs ?? PREVIEW_READY_POLL_MS;
  const started = deps.now();
  let waited = false;
  while (!(await deps.probe(origin).catch(() => false))) {
    if (deps.now() - started >= timeout) {
      log("not_ready", `waited_ms=${deps.now() - started}`);
      return { kind: "not_ready" };
    }
    waited = true;
    await deps.sleep(poll);
  }
  if (waited) log("ready", `waited_ms=${deps.now() - started}`);
  return deps.scan({ preview_url: url, tenant_id: input.tenantId, site_id: siteId, site_name: siteName });
}

async function waitForRun(runId: string, tenantId: string, deps: PreviewCheckDeps): Promise<string | null> {
  const timeout = deps.fixTimeoutMs ?? PREVIEW_FIX_TIMEOUT_MS;
  const poll = deps.fixPollMs ?? PREVIEW_FIX_POLL_MS;
  const started = deps.now();
  for (;;) {
    const run = await deps.loadRun(tenantId, runId).catch(() => null);
    const status = run?.status ?? null;
    if (status && !RUNNING.has(status)) return status;
    if (deps.now() - started >= timeout) return null;
    await deps.sleep(poll);
  }
}
