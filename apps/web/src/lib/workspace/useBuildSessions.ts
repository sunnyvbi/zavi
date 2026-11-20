"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import type { BuildSessionMeta } from "@/lib/workspace/buildHistory";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";

export type BuildSiteFlags = {
  siteNames: boolean;
  siteRepoChip: boolean;
  siteListDetails: boolean;
};

export const NO_SITE_FLAGS: BuildSiteFlags = { siteNames: false, siteRepoChip: false, siteListDetails: false };

export const DEFAULT_SITE_FLAGS: BuildSiteFlags = { siteNames: true, siteRepoChip: true, siteListDetails: true };

export type BuildUiFlags = {
  publishWaitsForApp: boolean;
  chatThreadFollowsBuild: boolean;
  recentRowsStable: boolean;
  mobileActions: boolean;
  chipsWrapMobile: boolean;
  publishOnRequest: boolean;
  figmaHandoff: boolean;
};

export const NO_UI_FLAGS: BuildUiFlags = {
  publishWaitsForApp: true,
  chatThreadFollowsBuild: false,
  recentRowsStable: false,
  mobileActions: false,
  chipsWrapMobile: false,
  publishOnRequest: true,
  figmaHandoff: false,
};

export const DEFAULT_UI_FLAGS: BuildUiFlags = {
  publishWaitsForApp: true,
  chatThreadFollowsBuild: true,
  recentRowsStable: true,
  mobileActions: true,
  chipsWrapMobile: true,
  publishOnRequest: true,
  figmaHandoff: true,
};

export type BuildSessionsSnapshot = {
  sessions: BuildSessionMeta[];
  currentSessionId: string | null;
  loaded: boolean;
  failed: boolean;
  flags: BuildSiteFlags;
  uiFlags: BuildUiFlags;
};

const EMPTY: BuildSessionsSnapshot = {
  sessions: [],
  currentSessionId: null,
  loaded: false,
  failed: false,
  flags: NO_SITE_FLAGS,
  uiFlags: NO_UI_FLAGS,
};

function flagOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readSiteFlags(raw: unknown): BuildSiteFlags {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    siteNames: flagOr(f.site_names, DEFAULT_SITE_FLAGS.siteNames),
    siteRepoChip: flagOr(f.site_repo_chip, DEFAULT_SITE_FLAGS.siteRepoChip),
    siteListDetails: flagOr(f.site_list_details, DEFAULT_SITE_FLAGS.siteListDetails),
  };
}

export function readUiFlags(raw: unknown): BuildUiFlags {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    publishWaitsForApp: flagOr(f.publish_waits_for_app, DEFAULT_UI_FLAGS.publishWaitsForApp),
    chatThreadFollowsBuild: flagOr(f.chat_thread_follows_build, DEFAULT_UI_FLAGS.chatThreadFollowsBuild),
    recentRowsStable: flagOr(f.recent_rows_stable, DEFAULT_UI_FLAGS.recentRowsStable),
    mobileActions: flagOr(f.mobile_actions, DEFAULT_UI_FLAGS.mobileActions),
    chipsWrapMobile: flagOr(f.chips_wrap_mobile, DEFAULT_UI_FLAGS.chipsWrapMobile),
    publishOnRequest: flagOr(f.publish_on_request, DEFAULT_UI_FLAGS.publishOnRequest),
    figmaHandoff: flagOr(f.figma_handoff, DEFAULT_UI_FLAGS.figmaHandoff),
  };
}

function failedSnapshot(prev: BuildSessionsSnapshot): BuildSessionsSnapshot {
  if (prev.loaded) return { ...prev, failed: true };
  return { ...prev, failed: true, flags: DEFAULT_SITE_FLAGS, uiFlags: DEFAULT_UI_FLAGS };
}

let snapshot: BuildSessionsSnapshot = EMPTY;
let inflight: Promise<void> | null = null;
let trailingRefresh = false;
let seq = 0;
const listeners = new Set<() => void>();
const LIVE_STATUS_POLL_MS = 10_000;
let pollers = 0;
let pollTimer: number | null = null;

function startLivePoll(): () => void {
  pollers += 1;
  if (pollTimer === null) {
    pollTimer = window.setInterval(() => {
      if (!document.hidden) void refreshBuildSessions();
    }, LIVE_STATUS_POLL_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    pollers = Math.max(0, pollers - 1);
    if (pollers === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function resetBuildSessions(): void {
  seq += 1;
  snapshot = EMPTY;
  inflight = null;
  trailingRefresh = false;
  emit();
}

export function __resetBuildSessionsForTest(): void {
  resetBuildSessions();
}

export async function refreshBuildSessions(): Promise<void> {
  if (inflight) {
    trailingRefresh = true;
    return inflight;
  }
  const mine = ++seq;
  inflight = (async () => {
    try {
      const res = await apiFetch("/api/workspace/autopilot/build-sessions");
      if (mine !== seq) return;
      if (!res.ok) {
        snapshot = failedSnapshot(snapshot);
        emit();
        return;
      }
      const json = (await res.json()) as {
        sessions?: BuildSessionMeta[];
        current_session_id?: string | null;
        flags?: unknown;
        ui_flags?: unknown;
      };
      if (mine !== seq) return;
      snapshot = {
        sessions: Array.isArray(json.sessions) ? json.sessions : [],
        currentSessionId: json.current_session_id ?? null,
        loaded: true,
        failed: false,
        flags: readSiteFlags(json.flags),
        uiFlags: readUiFlags(json.ui_flags),
      };
      registerSessionScopedCache(resetBuildSessions);
      emit();
    } catch {
      if (mine === seq) {
        snapshot = failedSnapshot(snapshot);
        emit();
      }
    } finally {
      inflight = null;
      if (trailingRefresh && mine === seq) {
        trailingRefresh = false;
        void refreshBuildSessions();
      }
    }
  })();
  return inflight;
}

export function notifyBuildSessionsChanged(): void {
  void refreshBuildSessions();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): BuildSessionsSnapshot {
  return snapshot;
}

export function readBuildSessions(): BuildSessionsSnapshot {
  return snapshot;
}

function getServerSnapshot(): BuildSessionsSnapshot {
  return EMPTY;
}

export function useBuildSessions(): BuildSessionsSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (!snapshot.loaded && !inflight) void refreshBuildSessions();
    const onVisible = () => {
      if (!document.hidden) void refreshBuildSessions();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const building = state.sessions.some(
    (session) =>
      session.state === "building" ||
      session.state === "publishing" ||
      session.site?.status === "publishing" ||
      session.site?.status === "waking",
  );
  useEffect(() => {
    if (!building) return;
    return startLivePoll();
  }, [building]);
  return state;
}
