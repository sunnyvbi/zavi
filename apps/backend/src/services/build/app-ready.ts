import { SITE_DATABASE_WAITING, authoredFounderCopy, founderBuildFailure } from "@zavi/shared";
import { continueRefusal } from "@/services/agents/continue-build";

export type PublishStatus = "none" | "publishing" | "live" | "failed";

export type PublishState = {
  status: PublishStatus;
  started_at: string | null;
  url: string | null;
  retryable: boolean;
  reason?: string;
  fixing?: true;
  waiting?: true;
};

export type AppReadyState = {
  app_ready: boolean;
  publish: PublishState;
};

export type AppReadyRun = {
  status?: string | null;
  failure_class?: string | null;
  paused_at?: string | null;
  updated_at?: string | null;
  spend_usd?: number | string | null;
  max_usd?: number | string | null;
};

export type SitePublishRun = {
  status?: string | null;
  created_at?: string | null;
  reason?: string | null;
  failure_class?: string | null;
  waiting_database?: boolean | null;
  repairing?: boolean | null;
};

export type SitePublishSignal = {
  site_status?: string | null;
  site_updated_at?: string | null;
  run?: SitePublishRun | null;
};

export type AppReadyNode = {
  status?: string | null;
  failure_class?: string | null;
  acceptance_attempts?: number | null;
  payload?: Record<string, unknown> | null;
  error?: string | null;
  last_failure_signal?: string | null;
  site_repair_pending?: boolean | null;
};

export function publishReason(raw: unknown, failureClass?: string | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const authored = authoredFounderCopy(raw);
  let f = founderBuildFailure({ class: failureClass ?? null, message: raw });
  if (f?.code === "internal" && !authored) f = founderBuildFailure({ class: "deploy_failed", message: raw });
  if (!f || (f.code === "publish_failed" && !authored)) return null;
  return f.message;
}

export function waitingForDatabase(node: { payload?: Record<string, unknown> | null } | undefined): boolean {
  const since = node?.payload?.site_capacity_wait_since;
  return typeof since === "number" && Number.isFinite(since);
}

const WAITING_DATABASE = { waiting: true as const, reason: SITE_DATABASE_WAITING };

function fixingReason(raw: unknown): string | null {
  return typeof raw === "string" ? authoredFounderCopy(raw) : null;
}

export const PUBLISH_FAILURE_CLASSES: ReadonlySet<string> = new Set(["deploy_failed", "acceptance_failed"]);

const NOT_RETRYABLE_CLASSES: ReadonlySet<string> = new Set(["user_cancelled", "provision_failed", "coach_precedence"]);

const STOPPED_RUN = new Set(["paused", "failed"]);

const NOT_READY: AppReadyState = {
  app_ready: false,
  publish: { status: "none", started_at: null, url: null, retryable: false },
};

function stageNode(graph: ReadonlyArray<AppReadyNode>, stage: string): AppReadyNode | undefined {
  return graph.find((n) => n?.payload?.stage === stage);
}

function onSite(node: AppReadyNode | undefined): boolean {
  const id = node?.payload?.site_id;
  return typeof id === "string" && id.trim().length > 0;
}

function enqueuedAt(node: AppReadyNode | undefined): string | null {
  const raw = node?.payload?.deploy_enqueued_at;
  const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoOrNull(raw: unknown): string | null {
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const PUBLISH_RUN_IN_FLIGHT = new Set(["provisioning", "active"]);
const PUBLISH_RUN_STOPPED = new Set(["failed", "halted"]);

export function awaitsPublishOnRequest(
  run: AppReadyRun,
  graph: ReadonlyArray<AppReadyNode> | null | undefined,
  url: string | null | undefined,
): boolean {
  const nodes = graph ?? [];
  if (nodes[0]?.payload?.refine_mode === true) return false;
  const build = stageNode(nodes, "build");
  return (
    run.status === "done" &&
    build?.status === "done" &&
    onSite(build) &&
    stageNode(nodes, "deploy") === undefined &&
    (url ?? null) === null
  );
}

export function sitePublishState(signal: SitePublishSignal | null | undefined): PublishState {
  return onRequestPublish(signal);
}

function onRequestPublish(signal: SitePublishSignal | null | undefined): PublishState {
  const run = signal?.run ?? null;
  const runStatus = run?.status ?? "";
  if (PUBLISH_RUN_IN_FLIGHT.has(runStatus)) {
    return {
      status: "publishing",
      started_at: isoOrNull(run?.created_at) ?? isoOrNull(signal?.site_updated_at),
      url: null,
      retryable: false,
      ...(run?.repairing === true ? { fixing: true as const } : run?.waiting_database === true ? WAITING_DATABASE : {}),
    };
  }
  if (PUBLISH_RUN_STOPPED.has(runStatus)) {
    const reason = publishReason(run?.reason, run?.failure_class);
    return { status: "failed", started_at: isoOrNull(run?.created_at), url: null, retryable: false, ...(reason ? { reason } : {}) };
  }
  if (signal?.site_status === "publishing") {
    return { status: "publishing", started_at: isoOrNull(signal.site_updated_at), url: null, retryable: false };
  }
  return { status: "none", started_at: null, url: null, retryable: false };
}

function budgetSpent(run: AppReadyRun): boolean {
  if (run.max_usd === null || run.max_usd === undefined || run.max_usd === "") return false;
  const cap = Number(run.max_usd);
  const spend = Number(run.spend_usd ?? 0);
  return Number.isFinite(cap) && Number.isFinite(spend) && spend >= cap;
}

export function deriveAppReady(
  run: AppReadyRun,
  graph: ReadonlyArray<AppReadyNode> | null | undefined,
  opts: { url?: string | null; current?: boolean; now?: number; site_publish?: SitePublishSignal | null } = {},
): AppReadyState {
  const nodes = graph ?? [];
  if (opts.current === false) return NOT_READY;
  if (nodes[0]?.payload?.refine_mode === true) return NOT_READY;
  const build = stageNode(nodes, "build");
  if (build?.status !== "done") return NOT_READY;

  const deploy = stageNode(nodes, "deploy");
  const url = opts.url ?? null;
  const started_at = enqueuedAt(deploy);
  const status = run.status ?? "";

  if (status === "done") {
    if (awaitsPublishOnRequest(run, nodes, url)) {
      return { app_ready: true, publish: onRequestPublish(opts.site_publish) };
    }
    return { app_ready: false, publish: { status: "live", started_at, url, retryable: false } };
  }

  const failedNodes = nodes.filter((n) => n?.status === "failed");
  const failureClass = run.failure_class ?? failedNodes[0]?.failure_class ?? null;
  if (
    STOPPED_RUN.has(status) &&
    ((failureClass !== null && PUBLISH_FAILURE_CLASSES.has(failureClass)) || deploy?.status === "failed")
  ) {
    const retryable =
      continueRefusal(
        {
          kind: "build_app",
          status,
          paused_at: run.paused_at ?? null,
          updated_at: run.updated_at ?? null,
          failure_class: failureClass,
          spend_usd: run.spend_usd,
          max_usd: run.max_usd,
          goal_graph: nodes,
        },
        opts.now,
      ) === null &&
      !NOT_RETRYABLE_CLASSES.has(failureClass ?? "") &&
      failedNodes.length > 0 &&
      !budgetSpent(run);
    const reason = publishReason(deploy?.status === "failed" ? deploy.error : failedNodes[0]?.error, failureClass);
    return { app_ready: true, publish: { status: "failed", started_at, url, retryable, ...(reason ? { reason } : {}) } };
  }

  if (
    status === "active" &&
    deploy !== undefined &&
    failedNodes.every((n) => n === deploy) &&
    (deploy.status === "pending" || deploy.status === "dispatched" || deploy.status === "done" || deploy.status === "failed")
  ) {
    const reason = deploy.site_repair_pending === true ? fixingReason(deploy.last_failure_signal) : null;
    const waiting = deploy.site_repair_pending !== true && waitingForDatabase(deploy);
    return {
      app_ready: true,
      publish: {
        status: "publishing",
        started_at,
        url,
        retryable: false,
        ...(deploy.site_repair_pending === true ? { fixing: true as const } : {}),
        ...(reason ? { reason } : {}),
        ...(waiting ? WAITING_DATABASE : {}),
      },
    };
  }

  return NOT_READY;
}

function acceptanceGateFailure(run: AppReadyRun, graph: ReadonlyArray<AppReadyNode>): boolean {
  const failureClass = run.failure_class ?? graph.find((n) => n?.status === "failed")?.failure_class ?? null;
  if (failureClass === "acceptance_failed") return true;
  const attempts = stageNode(graph, "deploy")?.acceptance_attempts;
  return typeof attempts === "number" && attempts > 0;
}

export function holdReadyForSmokeGate(
  state: AppReadyState,
  smokeGate: boolean,
  run: AppReadyRun = {},
  graph: ReadonlyArray<AppReadyNode> | null | undefined = [],
): AppReadyState {
  if (!smokeGate || !state.app_ready) return state;
  if (state.publish.status === "failed" && !acceptanceGateFailure(run, graph ?? [])) return state;
  return { ...state, app_ready: false };
}

export function publishUrlFromResources(
  rows: ReadonlyArray<{ resource_kind?: string | null; external_ref?: unknown }> | null | undefined,
  hostingUrl: string | null,
): string | null {
  const domain = (rows ?? []).find((r) => r.resource_kind === "domain");
  const ref = domain?.external_ref as { hostname?: unknown; status?: unknown } | null | undefined;
  if (ref && ref.status === "live" && typeof ref.hostname === "string" && ref.hostname.length > 0) {
    return `https://${ref.hostname}`;
  }
  return hostingUrl;
}

export const PUBLISH_PREVIEW_KICK_TTL_MS = 60_000;
const PUBLISH_PREVIEW_KICK_MAX = 500;
const publishPreviewKicks = new Map<string, number>();

export function claimPublishPreviewKick(runId: string, nowMs: number = Date.now()): boolean {
  const last = publishPreviewKicks.get(runId);
  if (last !== undefined && nowMs - last < PUBLISH_PREVIEW_KICK_TTL_MS) return false;
  if (publishPreviewKicks.size >= PUBLISH_PREVIEW_KICK_MAX) {
    for (const [k, at] of publishPreviewKicks) {
      if (nowMs - at >= PUBLISH_PREVIEW_KICK_TTL_MS) publishPreviewKicks.delete(k);
    }
    if (publishPreviewKicks.size >= PUBLISH_PREVIEW_KICK_MAX) {
      const oldest = publishPreviewKicks.keys().next();
      if (!oldest.done) publishPreviewKicks.delete(oldest.value);
    }
  }
  publishPreviewKicks.delete(runId);
  publishPreviewKicks.set(runId, nowMs);
  return true;
}

export function __resetPublishPreviewKicks(): void {
  publishPreviewKicks.clear();
}
