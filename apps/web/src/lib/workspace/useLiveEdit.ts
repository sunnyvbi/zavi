"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createVisiblePoller } from "./useBuildPreview";

export const LIVE_EDIT_FAST_POLL_MS = 3000;
export const LIVE_EDIT_SLOW_POLL_MS = 15000;
export const LIVE_EDIT_MAX_BACKOFF_MS = 120000;
export const LIVE_EDIT_RESOLVE_WAIT_MS = 3000;
export const LIVE_EDIT_START_TIMEOUT_MS = 90_000;

export type LiveEditKnown = "unknown" | "on" | "off";

export type LiveEditState = {
  enabled: boolean;
  draft: {
    exists: boolean;
    ahead_by: number;
    behind_by: number;
    head_sha: string | null;
    changes: Array<{ sha: string; message: string }>;
  };
  preview: { status: "live" | "starting" | "none"; url: string | null };
  refine_active: boolean;
};

export const LIVE_EDIT_OFF: LiveEditState = {
  enabled: false,
  draft: { exists: false, ahead_by: 0, behind_by: 0, head_sha: null, changes: [] },
  preview: { status: "none", url: null },
  refine_active: false,
};

export type LiveEditActionResult = { ok: true; commit_sha?: string } | { ok: false; message: string };

async function readMessage(res: Response, fallback: string): Promise<string> {
  if (res.status === 403) return "Only workspace owners and admins can do this.";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function liveEditFrameUrl(state: LiveEditState): string | null {
  if (!state.enabled || state.preview.status !== "live" || !state.preview.url) return null;
  if (state.draft.behind_by > 0) return null;
  if (state.draft.ahead_by > 0 || state.refine_active) return state.preview.url;
  return null;
}

export function liveEditNeedsWake(state: LiveEditState): boolean {
  return (
    state.enabled &&
    state.preview.status === "none" &&
    state.draft.ahead_by > 0 &&
    state.draft.behind_by === 0 &&
    !state.refine_active &&
    !!state.draft.head_sha
  );
}

export function liveEditPreviewStarting(state: LiveEditState): boolean {
  return state.enabled && state.preview.status === "starting" && state.draft.ahead_by > 0 && state.draft.behind_by === 0;
}

export function useLiveEdit(active: boolean, opts: { autoWake?: boolean } = {}) {
  const autoWake = opts.autoWake ?? true;
  const [state, setState] = useState<LiveEditState>(LIVE_EDIT_OFF);
  const [known, setKnownState] = useState<LiveEditKnown>("unknown");
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const knownRef = useRef<LiveEditKnown>("unknown");
  const readRef = useRef<(() => Promise<unknown>) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setKnown = useCallback((k: LiveEditKnown) => {
    knownRef.current = k;
    setKnownState(k);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setKnown("unknown");
      setState(LIVE_EDIT_OFF);
      return;
    }
    let cancelled = false;
    let failures = 0;
    let inflight: Promise<LiveEditState | "off" | null> | null = null;
    const read = (): Promise<LiveEditState | "off" | null> => {
      if (inflight) return inflight;
      const request = (async (): Promise<LiveEditState | "off" | null> => {
        let next: LiveEditState | null = null;
        let status = 0;
        try {
          const framed = liveEditFrameUrl(stateRef.current) !== null;
          const res = await apiFetch(`/api/workspace/autopilot/live-edit${framed ? "?framed=1" : ""}`);
          status = res.status;
          if (res.ok) next = (await res.json()) as LiveEditState;
        } catch {
          next = null;
        }
        if (cancelled) return null;
        if (status === 403 || status === 404) {
          setKnown("off");
          stateRef.current = LIVE_EDIT_OFF;
          setState(LIVE_EDIT_OFF);
          return "off";
        }
        if (next) {
          setKnown(next.enabled ? "on" : "off");
          stateRef.current = next;
          setState(next);
        }
        return next;
      })();
      inflight = request;
      void request.finally(() => {
        if (inflight === request) inflight = null;
      });
      return request;
    };
    readRef.current = read;
    const poller = createVisiblePoller(() => void poll());
    const poll = async () => {
      const next = await read();
      if (cancelled || next === "off") return;
      if (!next) {
        failures += 1;
        poller.schedule(Math.min(LIVE_EDIT_SLOW_POLL_MS * 2 ** failures, LIVE_EDIT_MAX_BACKOFF_MS));
        return;
      }
      failures = 0;
      if (!next.enabled) return;
      const busy = next.refine_active || next.preview.status === "starting";
      poller.schedule(busy ? LIVE_EDIT_FAST_POLL_MS : LIVE_EDIT_SLOW_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (readRef.current === read) readRef.current = null;
      poller.stop();
    };
  }, [active, nonce, setKnown]);

  const resolveEnabled = useCallback(async (waitMs: number = LIVE_EDIT_RESOLVE_WAIT_MS): Promise<boolean> => {
    const now = knownRef.current;
    if (now !== "unknown") return now === "on";
    const read = readRef.current;
    if (!read) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      read(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return knownRef.current === "on";
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const act = useCallback(
    async (path: "publish" | "discard" | "wake", fallback: string): Promise<LiveEditActionResult> => {
      try {
        const res = await apiFetch(`/api/workspace/autopilot/live-edit/${path}`, {
          method: "POST",
          idempotent: path === "publish",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) return { ok: false, message: await readMessage(res, fallback) };
        const j = (await res.json().catch(() => ({}))) as { commit_sha?: string };
        return { ok: true, commit_sha: j.commit_sha };
      } catch {
        return { ok: false, message: "We couldn't reach the server. Try again." };
      } finally {
        if (mounted.current) refresh();
      }
    },
    [refresh],
  );

  const autoWokenSha = useRef<string | null>(null);
  const [autoWaking, setAutoWaking] = useState(false);
  const [startEpoch, setStartEpoch] = useState(0);
  const [startStalled, setStartStalled] = useState(false);
  useEffect(() => {
    if (!active || !autoWake || !liveEditNeedsWake(state)) return;
    const sha = state.draft.head_sha;
    if (!sha || autoWokenSha.current === sha) return;
    autoWokenSha.current = sha;
    setAutoWaking(true);
    setStartEpoch((n) => n + 1);
    void act("wake", "The preview didn't start. Try again.").finally(() => {
      if (mounted.current) setAutoWaking(false);
    });
  }, [active, autoWake, state, act]);

  const booting = autoWaking || liveEditPreviewStarting(state);
  useEffect(() => {
    setStartStalled(false);
    if (!booting) return;
    const timer = setTimeout(() => {
      if (mounted.current) setStartStalled(true);
    }, LIVE_EDIT_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [booting, startEpoch]);

  const publish = useCallback(() => act("publish", "We couldn't publish your changes. Try again."), [act]);
  const discard = useCallback(() => act("discard", "We couldn't discard the draft. Try again."), [act]);
  const wake = useCallback(() => {
    setStartEpoch((n) => n + 1);
    return act("wake", "The preview didn't start. Try again.");
  }, [act]);

  return {
    state,
    known,
    resolveEnabled,
    refresh,
    publish,
    discard,
    wake,
    frameUrl: liveEditFrameUrl(state),
    loadingLatest: booting && !startStalled,
  };
}
