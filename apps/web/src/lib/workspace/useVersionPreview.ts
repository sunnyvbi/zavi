"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { noteSitePreviewCookie } from "./sitePreviewCookie";

export type VersionPreviewStatus = "idle" | "starting" | "live" | "dead";

export type VersionPreviewState = {
  status: VersionPreviewStatus;
  url: string | null;
  error: string | null;
  expiresAt?: number | null;
  retryable?: boolean;
};

export const VERSION_PREVIEW_POLL_MS = 3000;
export const VERSION_PREVIEW_POLL_MAX_MS = 15_000;
export const VERSION_PREVIEW_MAX_WAIT_MS = 21 * 60_000;
const FAST_POLLS = 10;

export function versionPollDelay(poll: number): number {
  if (poll <= FAST_POLLS) return VERSION_PREVIEW_POLL_MS;
  return Math.min(VERSION_PREVIEW_POLL_MAX_MS, Math.round(VERSION_PREVIEW_POLL_MS * 1.5 ** (poll - FAST_POLLS)));
}
export const VERSION_LINK_RENEW_BEFORE_MS = 60_000;

type Job = { status?: string; url?: string | null; error?: string | null; expires_at?: string | null; retryable?: boolean };

function fromJob(job: Job | null): VersionPreviewState {
  if (!job || job.status === "none") return { status: "starting", url: null, error: null };
  if (job.status === "live" && job.url) {
    const at = typeof job.expires_at === "string" ? Date.parse(job.expires_at) : NaN;
    return { status: "live", url: job.url, error: null, expiresAt: Number.isFinite(at) ? at : null };
  }
  if (job.status === "dead") return { status: "dead", url: null, error: job.error ?? "The preview didn't start.", retryable: job.retryable !== false };
  return { status: "starting", url: null, error: null };
}

const IDLE: VersionPreviewState = { status: "idle", url: null, error: null };
const STARTING: VersionPreviewState = { status: "starting", url: null, error: null };

const liveLinks = new Map<string, { url: string; expiresAt: number }>();

export function __resetVersionPreviewCache(): void {
  liveLinks.clear();
}

function cachedLive(runId: string): VersionPreviewState | null {
  const hit = liveLinks.get(runId);
  if (!hit) return null;
  if (hit.expiresAt - VERSION_LINK_RENEW_BEFORE_MS <= Date.now()) {
    liveLinks.delete(runId);
    return null;
  }
  return { status: "live", url: hit.url, error: null, expiresAt: hit.expiresAt };
}

function remember(runId: string, next: VersionPreviewState): void {
  if (next.status === "live" && next.url && next.expiresAt) liveLinks.set(runId, { url: next.url, expiresAt: next.expiresAt });
  else if (next.status === "dead") liveLinks.delete(runId);
}

function initialFor(runId: string | null): VersionPreviewState {
  if (!runId) return IDLE;
  return cachedLive(runId) ?? STARTING;
}

export function useVersionPreview(runId: string | null): VersionPreviewState & { retry: () => void } {
  const [tagged, setTagged] = useState<{ runId: string | null; value: VersionPreviewState }>(() => ({ runId, value: initialFor(runId) }));
  const state = tagged.runId === runId ? tagged.value : initialFor(runId);
  const [round, setRound] = useState(0);
  const polls = useRef(0);
  const renewing = useRef(false);

  useEffect(() => {
    if (!runId) {
      setTagged({ runId: null, value: IDLE });
      return;
    }
    const renew = renewing.current;
    renewing.current = false;
    if (!renew) {
      const hit = cachedLive(runId);
      if (hit) {
        setTagged({ runId, value: hit });
        return;
      }
      setTagged({ runId, value: STARTING });
    }
    let cancelled = false;
    let timer: number | null = null;
    polls.current = 0;
    const startedAt = Date.now();
    const setState = (next: VersionPreviewState) => {
      remember(runId, next);
      setTagged({ runId, value: next });
    };

    const readJob = async (res: Response): Promise<Job | null> => {
      try {
        return (await res.json()) as Job;
      } catch {
        return null;
      }
    };

    const poll = async () => {
      if (cancelled) return;
      polls.current += 1;
      try {
        const res = await apiFetch(`/api/workspace/autopilot/version-preview?conductor_run_id=${encodeURIComponent(runId)}`);
        if (cancelled) return;
        const next = res.ok ? fromJob(await readJob(res)) : { status: "starting" as const, url: null, error: null };
        if (next.status !== "starting") {
          setState(next);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      const delay = versionPollDelay(polls.current);
      if (Date.now() - startedAt + delay > VERSION_PREVIEW_MAX_WAIT_MS) {
        setState({ status: "dead", url: null, error: "The preview is taking too long to start." });
        return;
      }
      timer = window.setTimeout(() => void poll(), delay);
    };

    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/autopilot/version-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conductor_run_id: runId }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const j = (await readJob(res)) as { error?: { message?: string } } | null;
          setState({ status: "dead", url: null, error: j?.error?.message ?? "We couldn't start a preview of this version." });
          return;
        }
        const first = fromJob(await readJob(res));
        if (first.status !== "starting") {
          setState(first);
          return;
        }
        timer = window.setTimeout(() => void poll(), VERSION_PREVIEW_POLL_MS);
      } catch {
        if (!cancelled) setState({ status: "dead", url: null, error: "We couldn't reach the server. Try again." });
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId, round]);

  useEffect(() => {
    if (state.status === "live" && state.url && state.expiresAt) noteSitePreviewCookie(state.url, state.expiresAt);
  }, [state.status, state.url, state.expiresAt]);

  useEffect(() => {
    if (state.status !== "live" || !state.expiresAt) return;
    const id = window.setTimeout(() => {
      renewing.current = true;
      setRound((n) => n + 1);
    }, Math.max(0, state.expiresAt - Date.now() - VERSION_LINK_RENEW_BEFORE_MS));
    return () => window.clearTimeout(id);
  }, [state.status, state.expiresAt]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { ...state, retry };
}
