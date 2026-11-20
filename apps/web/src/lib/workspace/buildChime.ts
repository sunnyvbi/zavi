"use client";

import { useCallback, useEffect, useRef } from "react";

export type ChimeKind = "done" | "failed";

const TERMINAL = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);
const FAILED = new Set(["failed", "halted"]);

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function primeBuildChime(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

const NOTES: Record<ChimeKind, Array<{ hz: number; at: number }>> = {
  done: [
    { hz: 880, at: 0 },
    { hz: 1318.5, at: 0.14 },
  ],
  failed: [
    { hz: 392, at: 0 },
    { hz: 261.6, at: 0.18 },
  ],
};

export function playBuildChime(kind: ChimeKind): boolean {
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.02;
    for (const note of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.hz;
      const t = start + note.at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.35);
    }
    return true;
  } catch {
    return false;
  }
}

export type ChimeRefine = { id: string; status: string };

export function nextChime(
  seen: Map<string, string> | null,
  refines: ReadonlyArray<ChimeRefine>,
): { chime: ChimeKind | null; seen: Map<string, string> } {
  const next = new Map<string, string>();
  let chime: ChimeKind | null = null;
  for (const r of refines) {
    next.set(r.id, r.status);
    if (!seen) continue;
    const before = seen.get(r.id);
    const wasRunning = before === undefined ? false : !TERMINAL.has(before);
    if (!wasRunning || !TERMINAL.has(r.status)) continue;
    if (r.status === "done") chime = chime ?? "done";
    else if (FAILED.has(r.status)) chime = "failed";
  }
  return { chime, seen: next };
}

export function settledChimeStatus(state: {
  appReady?: boolean;
  runStatus: string | null;
}): string | null {
  return state.appReady === true && !TERMINAL.has(state.runStatus ?? "") ? "done" : state.runStatus;
}

export function chimeForSettledBuild(runStatus: string | null): ChimeKind | null {
  if (runStatus === "done") return "done";
  if (runStatus && FAILED.has(runStatus)) return "failed";
  return null;
}

export function useBuildDoneChime(opts: {
  active: boolean;
  settledNonce: number;
  runStatus: string | null;
  refines: ReadonlyArray<ChimeRefine> | null | undefined;
  play?: (kind: ChimeKind) => void;
}) {
  const { active, settledNonce, runStatus, refines } = opts;
  const rawPlay = opts.play ?? playBuildChime;
  const lastPlayed = useRef(0);
  const play = useCallback(
    (kind: ChimeKind) => {
      const now = Date.now();
      if (now - lastPlayed.current < 3000) return;
      lastPlayed.current = now;
      rawPlay(kind);
    },
    [rawPlay],
  );
  const seen = useRef<Map<string, string> | null>(null);
  const lastNonce = useRef(settledNonce);

  useEffect(() => {
    if (!active) return;
    const prime = () => primeBuildChime();
    window.addEventListener("pointerdown", prime, { once: true });
    window.addEventListener("keydown", prime, { once: true });
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, [active]);

  useEffect(() => {
    if (settledNonce === lastNonce.current) return;
    lastNonce.current = settledNonce;
    if (!active) return;
    const kind = chimeForSettledBuild(runStatus);
    if (kind) play(kind);
  }, [active, settledNonce, runStatus, play]);

  useEffect(() => {
    if (!active || !refines) return;
    const r = nextChime(seen.current, refines);
    seen.current = r.seen;
    if (r.chime) play(r.chime);
  }, [active, refines, play]);
}
