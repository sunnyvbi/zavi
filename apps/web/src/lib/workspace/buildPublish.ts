import { isFounderBuildLine } from "@zavi/shared";

export type BuildPublishStatus = "none" | "publishing" | "live" | "failed";

export type BuildPublish = {
  status: BuildPublishStatus;
  startedAt: string | null;
  url: string | null;
  retryable: boolean;
  reason?: string;
  fixing?: true;
  waiting?: true;
};

export const NO_PUBLISH: BuildPublish = { status: "none", startedAt: null, url: null, retryable: false };

const PUBLISH_STATUSES: ReadonlySet<string> = new Set(["none", "publishing", "live", "failed"]);

export type BuildPublishResponse = {
  status?: string | null;
  started_at?: string | null;
  url?: string | null;
  retryable?: boolean | null;
  reason?: string | null;
  fixing?: boolean | null;
  waiting?: boolean | null;
} | null;

export function readBuildPublish(raw: BuildPublishResponse | undefined): BuildPublish {
  if (!raw || typeof raw !== "object") return NO_PUBLISH;
  const status = typeof raw.status === "string" && PUBLISH_STATUSES.has(raw.status)
    ? (raw.status as BuildPublishStatus)
    : "none";
  const fixing = status === "publishing" && raw.fixing === true;
  const waiting = status === "publishing" && !fixing && raw.waiting === true;
  const text = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const reason =
    (status === "failed" || fixing || waiting) && text && isFounderBuildLine(text) ? text : null;
  return {
    status,
    startedAt: typeof raw.started_at === "string" ? raw.started_at : null,
    url: typeof raw.url === "string" && raw.url.length > 0 ? raw.url : null,
    retryable: status === "failed" && raw.retryable === true,
    ...(reason ? { reason } : {}),
    ...(fixing ? { fixing: true as const } : {}),
    ...(waiting ? { waiting: true as const } : {}),
  };
}

export type PublishWatch = {
  runId: string | null;
  runStatus: string | null;
  appReady: boolean;
  publishStatus: BuildPublishStatus;
};

export function publishWentLive(
  prev: PublishWatch | null,
  next: PublishWatch,
  publishOnRequest = false,
): boolean {
  if (!prev || !prev.runId || prev.runId !== next.runId) return false;
  if (publishOnRequest) {
    const couldPublish = prev.appReady || prev.publishStatus === "publishing" || prev.runStatus === "done";
    return couldPublish && prev.publishStatus !== "live" && next.publishStatus === "live";
  }
  const wasLive = prev.publishStatus === "live" || prev.runStatus === "done";
  const isLive = next.publishStatus === "live" || next.runStatus === "done";
  const wasPublishing = prev.appReady || prev.publishStatus === "publishing";
  return wasPublishing && !wasLive && isLive;
}

export const BUILD_RUN_RESUMED_EVENT = "zavi:build-run-resumed";

export function buildPublishesOnRequest(
  stages: ReadonlyArray<{ stage: string }>,
  publishOnRequest: boolean,
): boolean {
  if (stages.length === 0) return publishOnRequest;
  return !stages.some((row) => row.stage === "deploy" || row.stage === "spec" || row.stage === "scaffold");
}

export function publishRequestStillPending(
  status: BuildPublishStatus,
  startedAt: string | null,
  startedAtWhenRequested: string | null,
): boolean {
  if (status === "publishing" || status === "live") return false;
  if (status === "failed" && startedAt !== startedAtWhenRequested) return false;
  return true;
}

export const PUBLISH_PICKUP_POLL_MS = 3000;
export const PUBLISH_PICKUP_MAX_TICKS = 20;
