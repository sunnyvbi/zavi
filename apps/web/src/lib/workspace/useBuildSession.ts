"use client";

import { creditRefusalFrom, type CreditRefusal } from "./creditRefusal";
import { isOldSiteFrozen, oldSiteFrozenFrom, OLD_SITE_FROZEN_FALLBACK, type OldSiteFrozenRefusal } from "@/lib/workspace/oldSiteRebuild";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { UNDO_PREVIEW_ONLY_NOTICE, UNDO_PREVIEW_STALE_NOTICE } from "./buildFraming";
import { readPreviewRestartState, type BuildPreviewRestartState } from "./buildPreviewRestart";
import type { RunPanel } from "@zavi/shared";
import {
  clearOptimisticBuildStart,
  markOptimisticBuildStart,
} from "@/lib/workspace/optimisticBuildStart";
import {
  BUILD_RUN_RESUMED_EVENT,
  NO_PUBLISH,
  readBuildPublish,
  type BuildPublish,
  type BuildPublishResponse,
} from "@/lib/workspace/buildPublish";
import {
  buildStatusPath,
  createVisiblePoller,
  isTerminalBuildRun,
  pollDelayMs,
  readPreviewUrl,
  sharedBuildRead,
  shouldKeepPolling,
  UNPUBLISHED_PREVIEW_POLL_MS,
  type BuildFailure,
  type BuildPreviewKind,
  type BuildStageRow,
} from "@/lib/workspace/useBuildPreview";
import { notifyBuildSessionsChanged } from "@/lib/workspace/useBuildSessions";
import { useBuildWatchPing } from "@/lib/workspace/useBuildWatchPing";
import { registerSessionScopedCache } from "./sessionScopedCache";
import { buildStartBody, buildStartKey, clearBuildStartKey, keepsBuildStartKey } from "./buildStartKey";
import { pendingBuildFigmaFrame, settleBuildFigmaFrame } from "./buildFigmaFrame";
import type { FigmaFrameRef } from "@zavi/shared";

const REFINES_POLL_MS = 8000;
export const REFINES_WATCH_MS = 30_000;
export const REFINES_WATCH_WINDOW_MS = 10 * 60_000;
const REFINE_APPEAR_POLL_MS = 1000;
const REFINE_APPEAR_MAX_WAIT_MS = 10000;
export const FAST_FIX_WATCH_POLL_MS = 10_000;
export const FAST_FIX_WATCH_MS = 6 * 60_000;
const TERMINAL = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);

export type RefinePickedElement = { tag: string; text: string | null; path: string | null };

export type RefineSelection = { selector: string; tag: string; text?: string; path?: string; src?: string };

export type BuildRefine = {
  id: string;
  message: string;
  selected_element?: RefinePickedElement | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
  finished_at?: string | null;
  summary?: string | null;
  failure_message?: string | null;
  pr_url?: string | null;
  awaiting_review?: boolean;
  draft?: boolean;
  discarded?: boolean;
  retry_of?: string | null;
  chat_thread_id?: string | null;
  preview_url?: string | null;
  engineer_run_id?: string | null;
  preview_path?: string | null;
  kind?: "change" | "restore" | "undo";
  panel?: RunPanel | null;
  undoable?: boolean;
  no_change?: boolean;
  declared_outcome?: "no_change" | "needs_input" | "refused" | null;
  declared_message?: string | null;
  saving?: boolean;
};

export type BuildSessionRun = {
  id: string;
  objective: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  stages: BuildStageRow[];
  failure: BuildFailure | null;
};

export type BuildSessionSnapshot = {
  loaded: boolean;
  notFound: boolean;
  authExpired: boolean;
  loadError: string | null;
  run: BuildSessionRun | null;
  isCurrent: boolean;
  retired: boolean;
  previewUrl: string | null;
  previewKind: BuildPreviewKind;
  previewState?: BuildPreviewRestartState | null;
  liveUrl: string | null;
  adminUrl: string | null;
  adminSetupEmail: string | null;
  siteOffline: boolean;
  liveAnnounce: boolean;
  liveAnnounceUrl: string | null;
  repoUrl: string | null;
  refines: BuildRefine[];
  refinesLoaded: boolean;
  appReady: boolean;
  appReadyAt: string | null;
  publish: BuildPublish;
  sitePublished?: boolean | null;
  photos?: BuildPhotosMissing | null;
};

export type BuildPhotosMissing = { reason: string; retry: "free" | "paid" };

export function readPhotosMissing(raw: unknown): BuildPhotosMissing | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { status?: unknown; reason?: unknown; retry?: unknown };
  if (p.status !== "missing") return null;
  const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim().slice(0, 200) : "Photos couldn't be added to your site.";
  return { reason, retry: p.retry === "paid" ? "paid" : "free" };
}

export const INITIAL_SESSION: BuildSessionSnapshot = {
  loaded: false,
  notFound: false,
  authExpired: false,
  loadError: null,
  run: null,
  isCurrent: true,
  retired: false,
  previewUrl: null,
  previewKind: "none",
  previewState: null,
  liveUrl: null,
  adminUrl: null,
  adminSetupEmail: null,
  siteOffline: false,
  liveAnnounce: false,
  liveAnnounceUrl: null,
  repoUrl: null,
  refines: [],
  refinesLoaded: false,
  appReady: false,
  appReadyAt: null,
  publish: NO_PUBLISH,
};

export type BuildSessionSeed = {
  id: string;
  objective: string;
  startedAt: number;
};

type StatusResponse = {
  run: {
    id?: string;
    objective?: string;
    status?: string;
    created_at?: string | null;
    updated_at?: string | null;
    stages?: BuildStageRow[] | null;
    failure?: BuildFailure | null;
  } | null;
  target?: { repo_url?: string | null; live_url?: string | null; admin_url?: string | null; admin_setup_email?: string | null; site_offline?: boolean; live_announce?: boolean; live_announce_url?: string | null } | null;
  preview?: { url?: string | null; kind?: BuildPreviewKind } | null;
  preview_state?: unknown;
  is_current?: boolean;
  retired?: boolean;
  app_ready?: boolean;
  publish?: BuildPublishResponse;
  site?: { published?: boolean } | null;
  photos?: unknown;
};

const MAX_CACHED_SESSIONS = 20;
const cachedSessions = new Map<string, BuildSessionSnapshot>();

export function readCachedBuildSession(id: string | null): BuildSessionSnapshot | null {
  return id ? cachedSessions.get(id) ?? null : null;
}

function rememberBuildSession(id: string, snapshot: BuildSessionSnapshot): void {
  registerSessionScopedCache(clearBuildSessionCache);
  cachedSessions.delete(id);
  cachedSessions.set(id, snapshot);
  while (cachedSessions.size > MAX_CACHED_SESSIONS) {
    const oldest = cachedSessions.keys().next().value;
    if (oldest === undefined) break;
    cachedSessions.delete(oldest);
  }
}

export function clearBuildSessionCache(): void {
  cachedSessions.clear();
}

function startingSnapshot(sessionId: string | null, seeded: BuildSessionSeed | null): BuildSessionSnapshot {
  if (seeded) return seededSnapshot(seeded);
  const cached = readCachedBuildSession(sessionId);
  return cached ? { ...cached, refinesLoaded: false } : INITIAL_SESSION;
}

export function seededSnapshot(seed: BuildSessionSeed): BuildSessionSnapshot {
  return {
    ...INITIAL_SESSION,
    loaded: true,
    run: {
      id: seed.id,
      objective: seed.objective,
      status: "provisioning",
      createdAt: new Date(seed.startedAt).toISOString(),
      updatedAt: null,
      stages: [],
      failure: null,
    },
  };
}

export function applyStatus(
  prev: BuildSessionSnapshot,
  json: StatusResponse,
  now: number = Date.now(),
): BuildSessionSnapshot {
  const run = json.run;
  if (!run || typeof run.id !== "string")
    return { ...prev, loaded: true, notFound: true };
  const appReady = json.app_ready === true;
  const sameRun = prev.run?.id === run.id;
  return {
    ...prev,
    loaded: true,
    notFound: false,
    authExpired: false,
    loadError: null,
    run: {
      id: run.id,
      objective: typeof run.objective === "string" ? run.objective : null,
      status: typeof run.status === "string" ? run.status : "active",
      createdAt: run.created_at ?? null,
      updatedAt: run.updated_at ?? null,
      stages: Array.isArray(run.stages) ? run.stages : [],
      failure: run.failure ?? null,
    },
    isCurrent: json.is_current !== false,
    retired: json.retired === true,
    previewUrl: readPreviewUrl(json.preview),
    previewKind: json.preview?.kind ?? "none",
    previewState: readPreviewRestartState(json.preview_state),
    liveUrl: json.target?.live_url ?? null,
    adminUrl: json.target?.live_url ? (json.target?.admin_url ?? null) : null,
    adminSetupEmail:
      json.target?.live_url && json.target?.admin_url ? (json.target?.admin_setup_email ?? null) : null,
    siteOffline: json.target?.site_offline === true,
    liveAnnounce: !!json.target?.live_url && json.target?.live_announce === true,
    liveAnnounceUrl:
      json.target?.live_url && json.target?.live_announce === true
        ? (json.target?.live_announce_url ?? json.target.live_url)
        : null,
    repoUrl: json.target?.repo_url ?? null,
    appReady,
    appReadyAt: appReady
      ? (sameRun && prev.appReadyAt) || new Date(now).toISOString()
      : null,
    publish: readBuildPublish(json.publish),
    sitePublished: json.site && typeof json.site.published === "boolean" ? json.site.published : null,
    photos: readPhotosMissing(json.photos),
  };
}

export function previewRevisionOf(refines: BuildRefine[]): string {
  const done = [...refines].reverse().find((r) => TERMINAL.has(r.status));
  return done ? `${done.id}-${done.status}` : "initial";
}

function changedNoCode(r: BuildRefine): boolean {
  return r.no_change === true || (r.declared_outcome !== null && r.declared_outcome !== undefined);
}

export function shippedRefineRevision(refines: BuildRefine[]): string | null {
  const done = [...refines]
    .reverse()
    .find((r) => r.status === "done" && r.draft !== true && r.awaiting_review !== true && r.kind !== "restore" && r.kind !== "undo" && !changedNoCode(r));
  return done ? done.id : null;
}

export function refineShippedSince(prev: string | null | undefined, next: string | null): boolean {
  return prev !== undefined && next !== null && next !== prev;
}

export function landedRefine(refines: BuildRefine[]): BuildRefine | null {
  return (
    [...refines]
      .reverse()
      .find((r) => r.status === "done" && r.awaiting_review !== true && r.kind !== "restore" && r.kind !== "undo" && !changedNoCode(r)) ?? null
  );
}

export function safePreviewPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const p = path.trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || p.length > 300) return null;
  if ([...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
  if (p.split(/[?#]/)[0].split("/").some((seg) => seg === "..")) return null;
  return p;
}

export function previewPathToOpen(
  prevLandedId: string | null | undefined,
  landedId: string | null,
  previewPath: string | null | undefined,
): string | null {
  if (!refineShippedSince(prevLandedId, landedId)) return null;
  const path = safePreviewPath(previewPath);
  return path && path !== "/" ? path : null;
}

export type RevisionBaseline = { session: string | null | undefined; armed: boolean; rev: string | null | undefined };

export const EMPTY_REVISION_BASELINE: RevisionBaseline = { session: undefined, armed: false, rev: undefined };

export function advanceRevisionBaseline(
  prev: RevisionBaseline,
  session: string | null,
  refinesLoaded: boolean,
  rev: string | null,
): { next: RevisionBaseline; prior: string | null | undefined } {
  if (prev.session === undefined) {
    return { next: { session, armed: true, rev: refinesLoaded ? rev : undefined }, prior: undefined };
  }
  if (prev.session !== session) return { next: { session, armed: !refinesLoaded, rev: undefined }, prior: undefined };
  if (!prev.armed) return { next: { ...prev, armed: !refinesLoaded }, prior: undefined };
  if (!refinesLoaded) return { next: prev, prior: undefined };
  return { next: { ...prev, rev }, prior: prev.rev };
}

export function busyRefineKey(refines: BuildRefine[]): string {
  return refines
    .filter((r) => !TERMINAL.has(r.status))
    .map((r) => r.id)
    .sort()
    .join(",");
}

export function gainedBusyRefine(prevKey: string | undefined, nextKey: string): boolean {
  if (prevKey === undefined || !nextKey) return false;
  const before = new Set(prevKey ? prevKey.split(",") : []);
  return nextKey.split(",").some((id) => !before.has(id));
}

export function isRefineBusy(refines: BuildRefine[]): boolean {
  return refines.some((r) => !TERMINAL.has(r.status));
}

export function buildSessionInProgress(snapshot: BuildSessionSnapshot, sessionId: string | null): boolean {
  const run = snapshot.run;
  if (!sessionId || !run || run.id !== sessionId) return false;
  return !TERMINAL.has(run.status) || snapshot.publish.status === "publishing" || isRefineBusy(snapshot.refines);
}

export function latestBusyRefine(refines: BuildRefine[]): BuildRefine | null {
  for (let index = refines.length - 1; index >= 0; index -= 1) {
    if (!TERMINAL.has(refines[index].status)) return refines[index];
  }
  return null;
}

export function refinesWatchDelay(run: BuildSessionRun | null, now: number): number | null {
  if (!run || run.status !== "done" || !run.updatedAt) return null;
  const doneAt = Date.parse(run.updatedAt);
  if (!Number.isFinite(doneAt)) return null;
  const left = doneAt + REFINES_WATCH_WINDOW_MS - now;
  return left > 0 ? Math.min(REFINES_WATCH_MS, left) : null;
}

export function shouldPollRefines(
  fetched: BuildRefine[] | null,
  fallback: BuildRefine[],
): boolean {
  return isRefineBusy(fetched ?? fallback);
}

export const PENDING_REFINE_GRACE_MS = 60_000;

export function unsavedPendingRefines(saved: BuildRefine[], pending: Record<string, BuildRefine>): string[] {
  return Object.entries(pending)
    .filter(([, p]) => !saved.some((r) => r.id === p.id))
    .map(([key]) => key);
}

export function activitySignature(s: BuildSessionSnapshot): string {
  return `${s.run?.status ?? ""}|${s.refines.map((r) => `${r.id}:${r.status}`).join(",")}`;
}

export const NEW_SESSION_KEY = "new";

export const BUILD_REFINE_PENDING_EVENT = "zavi:build-refine-pending";
type PendingRefineDetail = { sessionId: string; clientId: string; refine: BuildRefine | null };

export const BUILD_REFINE_STARTED_EVENT = "zavi:build-refine-started";
export const BUILD_REFINE_SUBMITTING_EVENT = "zavi:build-refine-submitting";

const submittingCounts = new Map<string, number>();

export function refineSubmittingFor(sessionId: string): boolean {
  return (submittingCounts.get(sessionId) ?? 0) > 0;
}

function markSubmitting(sessionId: string, delta: 1 | -1): void {
  const next = Math.max(0, (submittingCounts.get(sessionId) ?? 0) + delta);
  if (next === 0) submittingCounts.delete(sessionId);
  else submittingCounts.set(sessionId, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BUILD_REFINE_SUBMITTING_EVENT, { detail: { sessionId, submitting: next > 0 } }));
  }
}
export const BUILD_CHANGES_LANDED_EVENT = "zavi:build-changes-landed";

export const BUILD_EDITS_SAVING_EVENT = "zavi:build-edits-saving";
export type SavingEditsEntry = { message: string; created_at: string; settledId: string | null; failed?: string | null };
type SavingEditsDetail = { sessionId: string; clientId: string; entry: SavingEditsEntry | null };

export function announceSavingEdits(sessionId: string, clientId: string, entry: SavingEditsEntry | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SavingEditsDetail>(BUILD_EDITS_SAVING_EVENT, { detail: { sessionId, clientId, entry } }));
}

export const BUILD_FAST_FIX_EVENT = "zavi:build-fast-fix";

export const BUILD_REFINE_FINISHED_EVENT = "zavi:build-refine-finished";

export const BUILD_SITE_PUBLISHED_EVENT = "zavi:build-site-published";

type SitePublishView = {
  liveUrl: string | null;
  unpublished?: { count: number } | null;
  unpublishedUnknown?: boolean;
} | null | undefined;

export function sitePublishLanded(prev: SitePublishView, next: SitePublishView): boolean {
  if (!prev || !next) return false;
  if (!prev.liveUrl && !!next.liveUrl) return true;
  if (next.unpublishedUnknown === true) return false;
  return (prev.unpublished?.count ?? 0) > 0 && (next.unpublished?.count ?? 0) === 0;
}

export type BuildRefineFinishedDetail = { sessionId: string; refineId: string; status: string };

export function finishedRefines(prev: BuildRefine[], next: BuildRefine[]): BuildRefine[] {
  const before = new Map(prev.map((r) => [r.id, r.status]));
  return next.filter((r) => {
    if (!TERMINAL.has(r.status)) return false;
    const was = before.get(r.id);
    return was === undefined || !TERMINAL.has(was);
  });
}

export type HeldChange = { kind: "held"; message: string };

export function isHeldChange(value: unknown): value is HeldChange {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "held";
}

export function refineRetryMessage(error: string | CreditRefusal | OldSiteFrozenRefusal | HeldChange): string {
  if (typeof error === "string") return error;
  if (isOldSiteFrozen(error) || isHeldChange(error)) return error.message;
  return `${error.headline} ${error.detail}`;
}

export const BUILD_CHANGE_BUSY_MESSAGE =
  "One change at a time. Another change is still running, so this one was not started. Your message is still in the box; press Send again when the current change finishes.";

export const BUILD_CHANGE_HELD_MESSAGE = "Your site is still building. I'll make this change as soon as it finishes.";

const BUSY_REFINE_CODES = new Set(["build_already_in_progress", "refine_in_progress"]);

export function isBuildChangeBusy(status: number, code: string | undefined): boolean {
  return status === 409 && code !== undefined && BUSY_REFINE_CODES.has(code);
}

function isRetryAlreadyStarted(status: number, payload: { error?: { code?: string } } | null): boolean {
  return status === 409 && payload?.error?.code === "refine_already_retried";
}

export function undoFailureCopy(status: number, code: string | undefined): string {
  if (code === "forbidden") return "Viewers can't undo changes. Ask a workspace owner, admin or member.";
  if (code === "old_site_frozen") return OLD_SITE_FROZEN_FALLBACK;
  if (code === "product_builder_disabled") return "Changing your app is turned off right now, so nothing was undone.";
  if (code === "undo_commit_not_found") {
    return "We couldn't find the saved version of this change, so it can't be undone from here. Your site hasn't changed.";
  }
  if (code === "newer_change") return "This change can't be undone any more, because your app changed after it.";
  if (code === "build_in_progress") return "Wait for the change that's running to finish, then try again.";
  if (code === "unpublished_draft") {
    return "Your preview has edits that aren't published yet. Publish or discard them, then try again.";
  }
  if (code === "undo_in_progress") return "This change is already being undone.";
  if (code === "no_undoable_refine" || status === 404) {
    return "This change can't be undone any more, because a newer change or undo came after it.";
  }
  if (code === "draft_not_published") return "This change isn't live yet, so there is nothing to undo.";
  if (code === "not_provisioned") return "Undo isn't available for this app.";
  return "Couldn't undo this change. Try again.";
}

export function undoSuccessNotice(
  body: { republished?: unknown; republish_pending?: unknown; draft_reset?: unknown; preview_only?: unknown; preview_stale?: unknown } | null,
): string | null {
  const notes: string[] = [];
  if (body?.preview_only === true) {
    notes.push(UNDO_PREVIEW_ONLY_NOTICE);
  } else if (body?.republished === false && body?.republish_pending === true) {
    notes.push("The change was undone. Your live site will update within a few minutes.");
  } else if (body?.republished === false) {
    notes.push("The change was undone, but the live site didn't update. Publish your site again to put the undo live.");
  }
  if (body?.preview_stale === true) {
    notes.push(UNDO_PREVIEW_STALE_NOTICE);
  }
  if (body?.draft_reset === false) {
    notes.push("Your preview may still show the old change. Discard the preview draft before your next edit.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

export function isPlainUndoNotice(notice: string): boolean {
  return notice === UNDO_PREVIEW_ONLY_NOTICE || notice === `${UNDO_PREVIEW_ONLY_NOTICE} ${UNDO_PREVIEW_STALE_NOTICE}`;
}

export type UndoOutcome = { error: string | null; notice: string | null };

export async function undoBuildRefine(sessionId: string, refineId: string): Promise<UndoOutcome> {
  try {
    const res = await apiFetch("/api/workspace/autopilot/refine-undo", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ conductor_run_id: refineId }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      return { error: undoFailureCopy(res.status, payload?.error?.code), notice: null };
    }
    const body = (await res.json().catch(() => null)) as {
      republished?: unknown;
      republish_pending?: unknown;
      draft_reset?: unknown;
      preview_only?: unknown;
      preview_stale?: unknown;
    } | null;
    notifyBuildSessionsChanged();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_STARTED_EVENT, { detail: { sessionId } }));
    }
    return { error: null, notice: undoSuccessNotice(body) };
  } catch {
    return { error: "Couldn't undo this change. Try again.", notice: null };
  }
}

export async function startBuildRefine(
  sessionId: string,
  message: string,
  opts: {
    retryOf?: string;
    optimistic?: boolean;
    photoRetry?: boolean;
    selection?: RefineSelection | null;
    imagePaths?: ReadonlyArray<string>;
  } = {},
): Promise<string | CreditRefusal | OldSiteFrozenRefusal | HeldChange | null> {
  const clientId = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const selection = opts.retryOf || opts.photoRetry ? null : (opts.selection ?? null);
  const imagePaths = opts.retryOf || opts.photoRetry ? [] : [...(opts.imagePaths ?? [])];
  const pending: BuildRefine = {
    id: clientId,
    message,
    status: "queued",
    created_at: new Date().toISOString(),
    ...(selection
      ? { selected_element: { tag: selection.tag, text: selection.text ?? null, path: selection.path ?? null } }
      : {}),
  };
  const announcePending = (refine: BuildRefine | null) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent<PendingRefineDetail>(BUILD_REFINE_PENDING_EVENT, { detail: { sessionId, clientId, refine } }));
    }
  };
  let accepted = false;
  if (opts.optimistic) announcePending(pending);
  markSubmitting(sessionId, 1);
  try {
    const res = await apiFetch("/api/workspace/autopilot/refine-product", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify(
        opts.retryOf
          ? { retry_of: opts.retryOf, conductor_run_id: sessionId }
          : opts.photoRetry
            ? { conductor_run_id: sessionId, photo_retry: true }
            : {
                message,
                conductor_run_id: sessionId,
                ...(selection ? { selection } : {}),
                ...(imagePaths.length > 0 ? { image_paths: imagePaths } : {}),
              },
      ),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      if (opts.retryOf && isRetryAlreadyStarted(res.status, payload)) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(BUILD_REFINE_STARTED_EVENT, { detail: { sessionId } }));
        }
        return null;
      }
      if (isBuildChangeBusy(res.status, payload?.error?.code)) return BUILD_CHANGE_BUSY_MESSAGE;
      const frozen = oldSiteFrozenFrom(payload);
      if (frozen) return frozen;
      return (
        creditRefusalFrom(payload, "change") ??
        payload?.error?.message ??
        `Couldn't start the update (HTTP ${res.status}).`
      );
    }
    const body = (await res.json().catch(() => null)) as {
      conductor_run_id?: unknown;
      fast_fix?: unknown;
      queued?: unknown;
      chat?: unknown;
    } | null;
    if (res.status === 202 && body?.queued === true) {
      return { kind: "held", message: typeof body.chat === "string" && body.chat.trim() ? body.chat : BUILD_CHANGE_HELD_MESSAGE };
    }
    if ((opts.optimistic || !opts.retryOf) && typeof body?.conductor_run_id === "string") {
      accepted = true;
      announcePending({ ...pending, id: body.conductor_run_id });
    }
    if (body?.fast_fix && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BUILD_FAST_FIX_EVENT, { detail: { sessionId } }));
    }
    notifyBuildSessionsChanged();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_STARTED_EVENT, { detail: { sessionId } }));
    }
    return null;
  } catch (error) {
    return (error as Error).message || "Couldn't start the update.";
  } finally {
    markSubmitting(sessionId, -1);
    if (opts.optimistic && !accepted) announcePending(null);
  }
}

export type ContinueRunError = { code: string; message: string };

export function useBuildSession(
  sessionId: string | null,
  seed: BuildSessionSeed | null,
): BuildSessionSnapshot & {
  sendRefine: (message: string, opts?: { photoRetry?: boolean; imagePaths?: ReadonlyArray<string> }) => Promise<string | CreditRefusal | OldSiteFrozenRefusal | HeldChange | null>;
  refineSubmitting: boolean;
  cancelRun: (targetId?: string) => Promise<string | null>;
  stopping: boolean;
  continueRun: () => Promise<ContinueRunError | null>;
  continuing: boolean;
  retry: () => void;
  savingEdits: BuildRefine[];
} {
  const seeded = seed && seed.id === sessionId ? seed : null;
  const [state, setState] = useState<BuildSessionSnapshot>(() => startingSnapshot(sessionId, seeded));
  const [pendingRefines, setPendingRefines] = useState<Record<string, BuildRefine>>({});
  const pendingRefinesRef = useRef(pendingRefines);
  pendingRefinesRef.current = pendingRefines;
  const pendingSinceRef = useRef<Record<string, number>>({});
  const [savingEditsMap, setSavingEditsMap] = useState<Record<string, SavingEditsEntry>>({});
  useEffect(() => {
    setSavingEditsMap({});
    const onSaving = (event: Event) => {
      const d = (event as CustomEvent<SavingEditsDetail>).detail;
      if (d.sessionId !== sessionId) return;
      setSavingEditsMap((prev) => {
        const next = { ...prev };
        if (d.entry) next[d.clientId] = d.entry;
        else delete next[d.clientId];
        return next;
      });
    };
    window.addEventListener(BUILD_EDITS_SAVING_EVENT, onSaving);
    return () => window.removeEventListener(BUILD_EDITS_SAVING_EVENT, onSaving);
  }, [sessionId]);
  useEffect(() => {
    setSavingEditsMap((prev) => {
      const entries = Object.entries(prev).filter(([, e]) => !e.settledId || !state.refines.some((saved) => saved.id === e.settledId));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
  }, [state.refines]);
  useEffect(() => {
    setPendingRefines({});
    const onPending = (event: Event) => {
      const d = (event as CustomEvent<PendingRefineDetail>).detail;
      if (d.sessionId !== sessionId) return;
      setPendingRefines((prev) => {
        const next = { ...prev };
        if (d.refine) next[`${d.sessionId}:${d.clientId}`] = d.refine;
        else delete next[`${d.sessionId}:${d.clientId}`];
        return next;
      });
    };
    window.addEventListener(BUILD_REFINE_PENDING_EVENT, onPending);
    return () => window.removeEventListener(BUILD_REFINE_PENDING_EVENT, onPending);
  }, [sessionId]);
  useEffect(() => {
    setPendingRefines((prev) => {
      const entries = Object.entries(prev).filter(([, r]) => !state.refines.some((saved) => saved.id === r.id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
  }, [state.refines]);
  const [refineSubmitting, setRefineSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const lastSignature = useRef<string | null>(null);
  const resumeSourceRef = useRef({});
  const mountedSessionRef = useRef<string | null | undefined>(undefined);
  useBuildWatchPing(sessionId, buildSessionInProgress(state, sessionId));

  useEffect(() => {
    if (!sessionId || mountedSessionRef.current !== sessionId) return;
    if (state.notFound || state.authExpired) {
      cachedSessions.delete(sessionId);
      return;
    }
    if (state.run?.id === sessionId) rememberBuildSession(sessionId, state);
  }, [sessionId, state]);

  const fetchRefines = useCallback(
    async (id: string, fresh: boolean = true): Promise<BuildRefine[] | null> => {
      try {
        const res = await sharedBuildRead(
          `/api/workspace/autopilot/refines?session_id=${encodeURIComponent(id)}`,
          { fresh },
        );
        if (sessionRef.current !== id || !res.ok) return null;
        const json = (await res.json()) as { refines?: BuildRefine[] };
        if (sessionRef.current !== id) return null;
        const refines = Array.isArray(json.refines)
          ? json.refines.slice().reverse()
          : [];
        const before = stateRef.current;
        const finished = before.refinesLoaded ? finishedRefines(before.refines, refines) : [];
        stateRef.current = { ...before, refines, refinesLoaded: true };
        setState((prev) => ({ ...prev, refines, refinesLoaded: true }));
        for (const refine of finished) {
          window.dispatchEvent(
            new CustomEvent<BuildRefineFinishedDetail>(BUILD_REFINE_FINISHED_EVENT, {
              detail: { sessionId: id, refineId: refine.id, status: refine.status },
            }),
          );
        }
        return refines;
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    if (mountedSessionRef.current !== sessionId) {
      mountedSessionRef.current = sessionId;
      const fresh = startingSnapshot(sessionId, seeded);
      stateRef.current = fresh;
      setState(fresh);
      lastSignature.current = null;
    }
    if (!sessionId) return;
    const id = sessionId;
    let cancelled = false;
    const statusPoller = createVisiblePoller(() => void statusTick(false));
    let refinesQueued = false;
    const refinesPoller = createVisiblePoller(() => {
      refinesQueued = false;
      void refinesTick(false);
    });
    const queueRefines = (delayMs: number): void => {
      refinesQueued = true;
      refinesPoller.schedule(delayMs);
    };
    const watchRefines = (): void => {
      if (refinesQueued) return;
      const delay = refinesWatchDelay(stateRef.current.run, Date.now());
      if (delay !== null) queueRefines(delay);
    };
    let settleTicks = 0;

    const unresolve = (reason: "authExpired" | "notFound"): void => {
      const next: BuildSessionSnapshot = {
        ...stateRef.current,
        loaded: true,
        run: null,
        loadError: null,
        previewUrl: null,
        previewKind: "none",
        previewState: null,
        liveUrl: null,
        adminUrl: null,
        adminSetupEmail: null,
        siteOffline: false,
        liveAnnounce: false,
        liveAnnounceUrl: null,
        repoUrl: null,
        appReady: false,
        appReadyAt: null,
        publish: NO_PUBLISH,
        authExpired: reason === "authExpired",
        notFound: reason === "notFound",
      };
      stateRef.current = next;
      setState(next);
    };

    const statusTick = async (fresh: boolean): Promise<void> => {
      let next = stateRef.current;
      try {
        const res = await sharedBuildRead(buildStatusPath(id), { fresh });
        if (cancelled) return;
        if (res.status === 401) {
          unresolve("authExpired");
          return;
        }
        if (res.status === 404) {
          unresolve("notFound");
          return;
        }
        if (res.ok) {
          const json = (await res.json()) as StatusResponse;
          if (cancelled) return;
          next = applyStatus(stateRef.current, json);
        } else if (!stateRef.current.loaded) {
          next = {
            ...stateRef.current,
            loaded: true,
            loadError: `Couldn't reach the build service (HTTP ${res.status}).`,
          };
        }
      } catch (error) {
        if (cancelled) return;
        if (!stateRef.current.loaded) {
          next = {
            ...stateRef.current,
            loaded: true,
            loadError: (error as Error).message || "Network error",
          };
        }
      }
      if (cancelled) return;
      stateRef.current = next;
      setState(next);
      watchRefines();
      const runStatus = next.run?.status ?? null;
      if (runStatus && !isTerminalBuildRun(runStatus))
        clearOptimisticBuildStart();
      if (next.loadError && !next.run) return;
      settleTicks = isTerminalBuildRun(runStatus) ? settleTicks + 1 : 0;
      if (!next.isCurrent) return;
      if (shouldKeepPolling(runStatus, next.previewKind, settleTicks, next.publish.status)) {
        statusPoller.schedule(pollDelayMs(runStatus));
        return;
      }
      if (runStatus === "done" && !next.liveUrl && (next.previewState === "starting" || next.previewState === "stopped"))
        statusPoller.schedule(UNPUBLISHED_PREVIEW_POLL_MS);
    };

    const refinesTick = async (fresh: boolean): Promise<void> => {
      const fetched = await fetchRefines(id, fresh);
      if (cancelled) return;
      const now = Date.now();
      const unsaved = unsavedPendingRefines(fetched ?? stateRef.current.refines, pendingRefinesRef.current);
      const since = pendingSinceRef.current;
      for (const key of Object.keys(since)) if (!unsaved.includes(key)) delete since[key];
      for (const key of unsaved) since[key] ??= now;
      const expired = unsaved.filter((key) => now - since[key]! >= PENDING_REFINE_GRACE_MS);
      if (expired.length > 0) {
        for (const key of expired) delete since[key];
        setPendingRefines((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !expired.includes(key))));
      }
      if (shouldPollRefines(fetched, stateRef.current.refines) || unsaved.length > expired.length) {
        queueRefines(REFINES_POLL_MS);
        return;
      }
      watchRefines();
    };

    void statusTick(true);
    void refinesTick(true);
    return () => {
      cancelled = true;
      statusPoller.stop();
      refinesPoller.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt, fetchRefines]);

  useEffect(() => {
    if (!sessionId || !state.loaded || !state.run) return;
    const signature = activitySignature(state);
    if (lastSignature.current !== null && lastSignature.current !== signature) {
      notifyBuildSessionsChanged();
    }
    lastSignature.current = signature;
  }, [sessionId, state]);

  useEffect(() => {
    if (!sessionId) return;
    const onStarted = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
      void fetchRefines(sessionId);
      setAttempt((value) => value + 1);
    };
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, onStarted);
    return () => window.removeEventListener(BUILD_REFINE_STARTED_EVENT, onStarted);
  }, [sessionId, fetchRefines]);

  useEffect(() => {
    if (!sessionId) return;
    const onLanded = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
      void fetchRefines(sessionId);
    };
    window.addEventListener(BUILD_CHANGES_LANDED_EVENT, onLanded);
    return () => window.removeEventListener(BUILD_CHANGES_LANDED_EVENT, onLanded);
  }, [sessionId, fetchRefines]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadline = 0;
    let running = false;
    const arm = () => {
      timer = setTimeout(() => void tick(), FAST_FIX_WATCH_POLL_MS);
    };
    const tick = async () => {
      timer = null;
      running = true;
      const fetched = await fetchRefines(sessionId);
      running = false;
      if (cancelled) return;
      if (fetched && isRefineBusy(fetched)) {
        setAttempt((value) => value + 1);
        return;
      }
      if (Date.now() < deadline) arm();
    };
    const onFastFix = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
      deadline = Date.now() + FAST_FIX_WATCH_MS;
      if (timer === null && !running) arm();
    };
    window.addEventListener(BUILD_FAST_FIX_EVENT, onFastFix);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener(BUILD_FAST_FIX_EVENT, onFastFix);
    };
  }, [sessionId, fetchRefines]);

  useEffect(() => {
    if (!sessionId) return;
    const onPublished = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
      void fetchRefines(sessionId);
      setAttempt((value) => value + 1);
    };
    window.addEventListener(BUILD_SITE_PUBLISHED_EVENT, onPublished);
    return () => window.removeEventListener(BUILD_SITE_PUBLISHED_EVENT, onPublished);
  }, [sessionId, fetchRefines]);

  useEffect(() => {
    if (!sessionId) return;
    const onResumed = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: string; source?: unknown }>).detail;
      if (detail?.source === resumeSourceRef.current) return;
      if (detail?.runId !== sessionId && detail?.runId !== stateRef.current.run?.id) return;
      setAttempt((value) => value + 1);
    };
    window.addEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
    return () => window.removeEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
  }, [sessionId]);

  const sendRefine = useCallback(
    async (
      message: string,
      opts: { photoRetry?: boolean; imagePaths?: ReadonlyArray<string> } = {},
    ): Promise<string | CreditRefusal | OldSiteFrozenRefusal | HeldChange | null> => {
      const id = sessionRef.current;
      if (!id) return "No build is open.";
      setRefineSubmitting(true);
      try {
        const error = await startBuildRefine(
          id,
          message,
          opts.photoRetry ? { photoRetry: true } : opts.imagePaths?.length ? { imagePaths: opts.imagePaths } : {},
        );
        if (sessionRef.current !== id) return null;
        if (error) return error;
        const deadline = Date.now() + REFINE_APPEAR_MAX_WAIT_MS;
        while (sessionRef.current === id && Date.now() < deadline) {
          const fetched = await fetchRefines(id);
          if (fetched && isRefineBusy(fetched)) break;
          await new Promise((resolve) => setTimeout(resolve, REFINE_APPEAR_POLL_MS));
        }
        return null;
      } finally {
        if (sessionRef.current === id) setRefineSubmitting(false);
      }
    },
    [fetchRefines],
  );

  const cancelRun = useCallback(async (targetId?: string): Promise<string | null> => {
    const id = sessionRef.current;
    const runId = targetId ?? stateRef.current.run?.id;
    if (!id || !runId) return null;
    setStopping(true);
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      if (sessionRef.current !== id) return null;
      if (!res.ok && res.status !== 404) {
        const payload = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        return (
          payload?.error?.message ??
          `Couldn't stop the build (HTTP ${res.status}).`
        );
      }
      setAttempt((value) => value + 1);
      notifyBuildSessionsChanged();
      return null;
    } catch (error) {
      return (error as Error).message || "Couldn't stop the build.";
    } finally {
      if (sessionRef.current === id) setStopping(false);
    }
  }, []);

  const continueRun = useCallback(async (): Promise<ContinueRunError | null> => {
    const id = sessionRef.current;
    const runId = stateRef.current.run?.id;
    if (!id || !runId) return null;
    setContinuing(true);
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/runs/${encodeURIComponent(runId)}/continue`,
        { method: "POST", idempotent: true },
      );
      if (sessionRef.current !== id) return null;
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        return {
          code: payload?.error?.code ?? `http_${res.status}`,
          message: payload?.error?.message ?? `Couldn't continue the build (HTTP ${res.status}).`,
        };
      }
      const resumed = stateRef.current.run;
      if (resumed?.id === runId) {
        const next = { ...stateRef.current, run: { ...resumed, status: "active", failure: null } };
        stateRef.current = next;
        setState(next);
      }
      setAttempt((value) => value + 1);
      notifyBuildSessionsChanged();
      window.dispatchEvent(
        new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId, source: resumeSourceRef.current } }),
      );
      return null;
    } catch (error) {
      return { code: "network", message: (error as Error).message || "Couldn't continue the build." };
    } finally {
      if (sessionRef.current === id) setContinuing(false);
    }
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const optimisticRefines = Object.entries(pendingRefines)
    .filter(([key]) => key.startsWith(`${sessionId}:`))
    .map(([, r]) => r)
    .filter((r) => !state.refines.some((saved) => saved.id === r.id));
  const savingEdits: BuildRefine[] = Object.entries(savingEditsMap)
    .filter(([, e]) => !e.settledId || !state.refines.some((saved) => saved.id === e.settledId))
    .map(([clientId, e]) => ({
      id: clientId,
      message: e.message,
      status: e.failed ? "failed" : e.settledId ? "saved" : "saving",
      created_at: e.created_at,
      saving: true,
      ...(e.failed ? { failure_message: e.failed } : {}),
    }));
  return { ...state, refines: [...state.refines, ...optimisticRefines], sendRefine, refineSubmitting, cancelRun, stopping, continueRun, continuing, retry, savingEdits };
}

export async function startBuildSession(input: {
  idea: string;
  companyName: string | undefined;
  template?: string | null;
  figma?: FigmaFrameRef | null;
}): Promise<{ id: string; figmaNote?: string } | { error: string; credit?: CreditRefusal }> {
  markOptimisticBuildStart();
  const figma = input.figma === undefined ? pendingBuildFigmaFrame() : input.figma;
  const requestBody = buildStartBody({ idea: input.idea, company_name: input.companyName, template: input.template, figma });
  const requestId = buildStartKey(requestBody);
  type StartResponse = {
    conductor_run_id?: string;
    figma_note?: unknown;
    error?: { code?: string; message?: string; run_id?: unknown };
  };
  const start = async () => {
    const res = await apiFetch("/api/workspace/autopilot/build-product", {
      method: "POST",
      retryOnNetworkError: false,
      idempotent: true,
      headers: { "Idempotency-Key": requestId },
      body: requestBody,
    });
    const payload = (res.ok ? await res.json() : await res.json().catch(() => null)) as StartResponse | null;
    return { res, payload };
  };
  try {
    let response: Awaited<ReturnType<typeof start>>;
    try { response = await start(); } catch { response = await start(); }
    for (let attempt = 0; attempt < 8 && response.payload?.error?.code === "idempotency_in_progress"; attempt++) {
      response = await start();
    }
    const { res, payload } = response;
    if (!res.ok) {
      clearOptimisticBuildStart();
      const unresolved = keepsBuildStartKey(payload?.error?.code);
      if (payload?.error?.code && !unresolved) clearBuildStartKey(requestId);
      if (unresolved) notifyBuildSessionsChanged();
      const failedRun = payload?.error?.code === "build_setup_failed" ? payload.error.run_id : null;
      if (typeof failedRun === "string" && failedRun) {
        clearBuildStartKey(requestId);
        notifyBuildSessionsChanged();
        if (figma) settleBuildFigmaFrame(payload?.figma_note, figma);
        return { id: failedRun };
      }
      const credit = creditRefusalFrom(payload, "build");
      if (credit) return { error: credit.headline, credit };
      if (payload?.error?.code === "build_already_in_progress") notifyBuildSessionsChanged();
      return {
        error:
          payload?.error?.code === "build_already_in_progress"
            ? "A build is already running. Stop it before starting another."
            : (payload?.error?.message ??
              `Couldn't start the build (HTTP ${res.status}).`),
      };
    }
    if (typeof payload?.conductor_run_id !== "string" || !payload.conductor_run_id) {
      clearOptimisticBuildStart();
      return { error: "The build didn't start. Please try again." };
    }
    clearBuildStartKey(requestId);
    notifyBuildSessionsChanged();
    if (figma) {
      settleBuildFigmaFrame(payload.figma_note, figma);
      if (typeof payload.figma_note === "string" && payload.figma_note) {
        return { id: payload.conductor_run_id, figmaNote: payload.figma_note };
      }
    }
    return { id: payload.conductor_run_id };
  } catch (error) {
    clearOptimisticBuildStart();
    return { error: (error as Error).message || "Couldn't start the build." };
  }
}
