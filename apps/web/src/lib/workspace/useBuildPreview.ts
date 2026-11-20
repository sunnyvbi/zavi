"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { clearOptimisticBuildStart } from "@/lib/workspace/optimisticBuildStart";
import { registerSessionScopedCache } from "./sessionScopedCache";
import {
  BUILD_RUN_RESUMED_EVENT,
  NO_PUBLISH,
  readBuildPublish,
  type BuildPublish,
  type BuildPublishResponse,
  type BuildPublishStatus,
} from "./buildPublish";
import { readPreviewRestartState, type BuildPreviewRestartState } from "./buildPreviewRestart";

export {
  BUILD_RUN_RESUMED_EVENT,
  NO_PUBLISH,
  readBuildPublish,
  type BuildPublish,
  type BuildPublishResponse,
  type BuildPublishStatus,
};

export const FAST_POLL_MS = 1500;

export const UNAUTHORIZED_BEFORE_GIVING_UP = 2;
export const SETTLE_POLL_MS = 3000;
export const MAX_SETTLE_TICKS = 20;

export const RESUME_READ_RETRIES = 5;
export const UNPUBLISHED_PREVIEW_POLL_MS = 15_000;

export const SHARED_READ_REUSE_MS = 1000;

export const NOT_CURRENT_BEFORE_STOPPING = 3;

type SharedRead = { ok: boolean; status: number; body: unknown };

export type SharedReadResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const sharedInflight = new Map<string, Promise<SharedRead>>();
const sharedSettled = new Map<string, { at: number; read: SharedRead }>();

let sharedGeneration = 0;

export function resetSharedBuildReads(): void {
  sharedGeneration += 1;
  sharedInflight.clear();
  sharedSettled.clear();
}

export async function sharedBuildRead(
  path: string,
  opts: { fresh?: boolean } = {},
): Promise<SharedReadResponse> {
  registerSessionScopedCache(resetSharedBuildReads);
  let pending = opts.fresh ? undefined : sharedInflight.get(path);
  if (!pending && !opts.fresh) {
    const hit = sharedSettled.get(path);
    if (hit && Date.now() - hit.at < SHARED_READ_REUSE_MS) pending = Promise.resolve(hit.read);
  }
  if (!pending) {
    const generation = sharedGeneration;
    const request = (async (): Promise<SharedRead> => {
      const res = await apiFetch(path);
      return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
    })();
    pending = request;
    sharedInflight.set(path, request);
    const release = () => {
      if (sharedInflight.get(path) === request) sharedInflight.delete(path);
    };
    request.then((read) => {
      release();
      if (generation === sharedGeneration) sharedSettled.set(path, { at: Date.now(), read });
    }, release);
  }
  const read = await pending;
  return { ok: read.ok, status: read.status, json: async () => read.body };
}

export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

export type VisiblePoller = { schedule: (delayMs: number) => void; stop: () => void };

export function createVisiblePoller(run: () => void): VisiblePoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let parked = false;
  let stopped = false;
  const onVisibility = () => {
    if (stopped || isPageHidden()) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      run();
    } else if (parked) {
      parked = false;
      run();
    }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  return {
    schedule(delayMs) {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        if (isPageHidden()) {
          parked = true;
          return;
        }
        run();
      }, delayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

export type BuildStatusScope = "workspace";

export function buildStatusPath(runId: string | null | undefined, scope?: BuildStatusScope): string {
  if (runId) return `/api/workspace/autopilot/build-status?run_id=${encodeURIComponent(runId)}`;
  return scope === "workspace"
    ? "/api/workspace/autopilot/build-status?app=workspace"
    : "/api/workspace/autopilot/build-status";
}

export type BuildPreviewKind = "none" | "instant" | "early" | "final";

export type BuildStageRow = {
  stage: string;
  status: string;
  error?: string | null;
  agent?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  attempt?: number | null;
  expected_ms?: number | null;
};

export type BuildFailure = {
  class?: string | null;
  code?: string | null;
  message?: string | null;
  stage?: string | null;
};

type BuildStatusResponse = {
  run: {
    id?: string;
    objective?: string;
    status?: string;
    created_at?: string | null;
    updated_at?: string | null;
    stages?: BuildStageRow[] | null;
    failure?: BuildFailure | null;
  } | null;
  preview?: { url?: string | null; kind?: BuildPreviewKind; compiling?: boolean } | null;
  preview_state?: unknown;
  is_current?: boolean;
  app_ready?: boolean;
  publish?: BuildPublishResponse;
  site?: {
    id?: unknown;
    hostname?: unknown;
    status?: unknown;
    live_url?: unknown;
    admin_url?: unknown;
    repo_url?: unknown;
    publish_failed?: unknown;
    unpublished_changes?: unknown;
    unpublished_changes_unknown?: unknown;
    search_hidden?: unknown;
  } | null;
};

export type BuildSite = {
  id: string;
  status: string;
  liveUrl: string | null;
  repoUrl: string | null;
  publishFailed?: boolean;
  unpublished?: SiteUnpublishedChanges | null;
  unpublishedUnknown?: boolean;
  searchHidden?: boolean;
};

export type SiteUnpublishedChange = { id: string; kind: "edit" | "undo"; at: string; message: string | null };

export type SiteUnpublishedChanges = {
  count: number;
  changes: SiteUnpublishedChange[];
  publish: BuildPublish;
};

export function readSiteUnpublished(raw: unknown): SiteUnpublishedChanges | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { count?: unknown; changes?: unknown; publish?: unknown };
  const count = typeof r.count === "number" && Number.isFinite(r.count) ? Math.max(0, Math.floor(r.count)) : 0;
  if (count === 0) return null;
  const changes = (Array.isArray(r.changes) ? r.changes : [])
    .map((c): SiteUnpublishedChange | null => {
      const x = (c ?? {}) as { id?: unknown; kind?: unknown; at?: unknown; message?: unknown };
      if (typeof x.id !== "string" || !x.id) return null;
      return {
        id: x.id,
        kind: x.kind === "undo" ? "undo" : "edit",
        at: typeof x.at === "string" ? x.at : "",
        message: typeof x.message === "string" && x.message.trim() ? x.message.trim().slice(0, 200) : null,
      };
    })
    .filter((c): c is SiteUnpublishedChange => c !== null)
    .slice(0, 10);
  return { count, changes, publish: readBuildPublish(r.publish as BuildPublishResponse) };
}

function httpsUrlOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

export function readBuildSite(site: BuildStatusResponse["site"]): BuildSite | null {
  if (!site || typeof site !== "object") return null;
  if (typeof site.id !== "string" || !site.id) return null;
  return {
    id: site.id,
    status: typeof site.status === "string" ? site.status : "unknown",
    liveUrl: httpsUrlOrNull(site.live_url),
    repoUrl: httpsUrlOrNull(site.repo_url),
    publishFailed: site.publish_failed === true,
    unpublished: readSiteUnpublished(site.unpublished_changes),
    ...(site.unpublished_changes_unknown === true ? { unpublishedUnknown: true } : {}),
    ...(site.search_hidden === true ? { searchHidden: true } : {}),
  };
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "halted",
  "paused",
  "cancelled",
  "canceled",
]);

export function isTerminalBuildRun(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

export function readPreviewUrl(
  preview: { url?: string | null; kind?: BuildPreviewKind } | null | undefined,
): string | null {
  if (!preview || !preview.kind || preview.kind === "none") return null;
  const u = preview.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

export function shouldKeepPolling(
  runStatus: string | null,
  previewKind: BuildPreviewKind,
  settleTicks: number,
  publishStatus: BuildPublishStatus = "none",
): boolean {
  if (runStatus === null) return false;
  if (publishStatus === "publishing") return true;
  if (!isTerminalBuildRun(runStatus)) return true;
  if (runStatus !== "done") return false;
  if (previewKind === "final") return false;
  return settleTicks < MAX_SETTLE_TICKS;
}

export function pollDelayMs(runStatus: string | null): number {
  return isTerminalBuildRun(runStatus) ? SETTLE_POLL_MS : FAST_POLL_MS;
}

export type BuildPreviewState = {
  loaded: boolean;
  classified?: boolean;
  building: boolean;
  runStatus: string | null;
  runId: string | null;
  objective: string | null;
  stages: BuildStageRow[];
  createdAt: string | null;
  updatedAt: string | null;
  previewUrl: string | null;
  previewKind: BuildPreviewKind;
  previewCompiling?: boolean;
  previewState?: BuildPreviewRestartState | null;
  failure: BuildFailure | null;
  appReady: boolean;
  publish: BuildPublish;
  site?: BuildSite | null;
  settledNonce: number;
};

const INITIAL: BuildPreviewState = {
  loaded: false,
  classified: false,
  building: false,
  runStatus: null,
  runId: null,
  objective: null,
  stages: [],
  createdAt: null,
  updatedAt: null,
  previewUrl: null,
  previewKind: "none",
  previewCompiling: false,
  previewState: null,
  failure: null,
  appReady: false,
  publish: NO_PUBLISH,
  site: null,
  settledNonce: 0,
};

export function toBuildPreviewState(
  json: BuildStatusResponse,
  prev: BuildPreviewState,
): BuildPreviewState {
  const run = json.run ?? null;
  const runStatus = typeof run?.status === "string" ? run.status : null;
  const terminal = isTerminalBuildRun(runStatus);
  const building = run !== null && !terminal;
  const appReady = run !== null && json.app_ready === true;
  const settled = prev.building && run !== null && !prev.appReady && (terminal || appReady);
  return {
    loaded: true,
    classified: true,
    building,
    runStatus,
    runId: typeof run?.id === "string" ? run.id : null,
    objective: typeof run?.objective === "string" ? run.objective : null,
    stages: Array.isArray(run?.stages) ? run.stages : [],
    createdAt: run?.created_at ?? null,
    updatedAt: run?.updated_at ?? null,
    previewUrl: readPreviewUrl(json.preview),
    previewKind: json.preview?.kind ?? "none",
    previewCompiling: json.preview?.kind === "instant" && json.preview?.compiling === true,
    previewState: readPreviewRestartState(json.preview_state),
    failure: run?.failure ?? null,
    appReady,
    publish: run ? readBuildPublish(json.publish) : NO_PUBLISH,
    site: run ? readBuildSite(json.site) : null,
    settledNonce: settled ? prev.settledNonce + 1 : prev.settledNonce,
  };
}

export function useBuildPreview(
  enabled: boolean = true,
  watchKey: string | number = 0,
  runId: string | null = null,
  scope?: BuildStatusScope,
): BuildPreviewState {
  const [state, setState] = useState<BuildPreviewState>(INITIAL);
  const [resumeNonce, setResumeNonce] = useState(0);
  const [shownRunId, setShownRunId] = useState(runId);
  if (shownRunId !== runId) {
    setShownRunId(runId);
    if (runId !== null && state.runId !== null && state.runId !== runId) {
      setState({ ...INITIAL, settledNonce: state.settledNonce });
    }
  }
  const stateRef = useRef(state);
  stateRef.current = state;
  const watchedRunRef = useRef(runId);

  useEffect(() => {
    if (!enabled) return;
    const onResumed = (event: Event) => {
      const resumed = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      if (!runId || resumed === runId || resumed === stateRef.current.runId) setResumeNonce((value) => value + 1);
    };
    window.addEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
    return () => window.removeEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
  }, [enabled, runId]);

  useEffect(() => {
    if (!enabled) return;
    let armed = watchedRunRef.current === runId;
    watchedRunRef.current = runId;
    let cancelled = false;
    let settleTicks = 0;
    const path = buildStatusPath(runId, scope);
    const poller = createVisiblePoller(() => void tick(false));

    let unauthorizedStreak = 0;

    let resumeUnanswered = resumeNonce > 0;
    let resumeRetries = 0;

    let notCurrentStreak = 0;
    let current = true;
    const tick = async (fresh: boolean): Promise<void> => {
      let next = stateRef.current;
      try {
        const res = await sharedBuildRead(path, { fresh });
        if (cancelled) return;
        if (runId && res.status === 404) {
          if (++notCurrentStreak >= NOT_CURRENT_BEFORE_STOPPING) {
            stateRef.current = { ...INITIAL, loaded: true, classified: true, settledNonce: stateRef.current.settledNonce };
            setState(stateRef.current);
            return;
          }
          stateRef.current = { ...stateRef.current, loaded: true };
          setState(stateRef.current);
          poller.schedule(pollDelayMs(stateRef.current.runStatus));
          return;
        }
        if (res.ok) {
          const json = (await res.json()) as BuildStatusResponse;
          if (cancelled) return;
          unauthorizedStreak = 0;
          resumeUnanswered = false;
          notCurrentStreak = runId && json.is_current === false ? notCurrentStreak + 1 : 0;
          current = notCurrentStreak < NOT_CURRENT_BEFORE_STOPPING;
          next = toBuildPreviewState(json, armed ? stateRef.current : { ...stateRef.current, building: false });
          armed = true;
        } else if (res.status === 401 && ++unauthorizedStreak < UNAUTHORIZED_BEFORE_GIVING_UP) {
          poller.schedule(FAST_POLL_MS);
          return;
        } else if (res.status === 401) {
          stateRef.current = { ...stateRef.current, loaded: true, building: false };
          setState(stateRef.current);
          return;
        } else {
          unauthorizedStreak = 0;
          next = { ...stateRef.current, loaded: true };
        }
      } catch {
        unauthorizedStreak = 0;
        next = { ...stateRef.current, loaded: true };
      }
      if (cancelled) return;
      stateRef.current = next;
      setState(next);
      if (next.building) clearOptimisticBuildStart();

      settleTicks = isTerminalBuildRun(next.runStatus) ? settleTicks + 1 : 0;
      if (runId && !next.classified) {
        poller.schedule(FAST_POLL_MS);
        return;
      }
      const changesPublishing = next.site?.unpublished?.publish.status === "publishing";
      const unpublishedSite = next.runStatus === "done" && next.site != null &&
        ((next.site.liveUrl === null && (next.site.status === "building" || next.site.status === "publishing")) ||
          changesPublishing ||
          ((!!next.site.unpublished || next.site.unpublishedUnknown === true) &&
            next.previewKind !== "instant" &&
            settleTicks < MAX_SETTLE_TICKS) ||
          (next.site.unpublishedUnknown === true && settleTicks < MAX_SETTLE_TICKS));
      if (current && resumeUnanswered && ++resumeRetries <= RESUME_READ_RETRIES) {
        poller.schedule(FAST_POLL_MS);
        return;
      }
      if (!current || (!unpublishedSite && !shouldKeepPolling(next.runStatus, next.previewKind, settleTicks, next.publish.status)))
        return;
      poller.schedule(unpublishedSite && next.publish.status !== "publishing" && !changesPublishing
        ? next.previewState === "starting" ? SETTLE_POLL_MS : UNPUBLISHED_PREVIEW_POLL_MS
        : pollDelayMs(next.runStatus));
    };

    void tick(true);
    return () => {
      cancelled = true;
      poller.stop();
    };
  }, [enabled, watchKey, runId, resumeNonce, scope]);

  return state;
}
