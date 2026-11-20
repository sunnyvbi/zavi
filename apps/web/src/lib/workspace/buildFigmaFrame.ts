"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { parseFigmaFrameUrl, type FigmaFrameRef } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "./sessionScopedCache";

export type BuildFigmaFrame = { link: string; ref: FigmaFrameRef };
export type BuildFigmaState = { frame: BuildFigmaFrame | null; note: string | null };
export type FigmaConnection = "loading" | "connected" | "not_connected" | "error";

let state: BuildFigmaState = { frame: null, note: null };
const listeners = new Set<() => void>();

function set(next: BuildFigmaState): void {
  state = next;
  for (const listener of listeners) listener();
}

registerSessionScopedCache(() => set({ frame: null, note: null }));

export function attachBuildFigmaFrame(link: string): boolean {
  const ref = parseFigmaFrameUrl(link);
  if (!ref) return false;
  set({ frame: { link: link.trim(), ref }, note: null });
  return true;
}

export function clearBuildFigmaFrame(): void {
  if (state.frame) set({ ...state, frame: null });
}

export function pendingBuildFigmaFrame(): FigmaFrameRef | null {
  return state.frame?.ref ?? null;
}

function sameFrame(a: FigmaFrameRef | null, b: FigmaFrameRef | null): boolean {
  return a?.file_key === b?.file_key && a?.node_id === b?.node_id;
}

export function settleBuildFigmaFrame(note: unknown, consumed: FigmaFrameRef | null = state.frame?.ref ?? null): void {
  if (consumed && !sameFrame(state.frame?.ref ?? null, consumed)) return;
  set({ frame: null, note: typeof note === "string" && note.trim() ? note.trim().slice(0, 300) : null });
}

export function dismissBuildFigmaNote(): void {
  if (state.note) set({ ...state, note: null });
}

export function useBuildFigmaFrame(): BuildFigmaState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}

export function useFigmaConnection(active: boolean): FigmaConnection {
  const [connection, setConnection] = useState<FigmaConnection>("loading");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setConnection((prev) => (prev === "connected" ? prev : "loading"));
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { connectors?: Array<{ slug?: unknown }> };
        const connected = (body.connectors ?? []).some((c) => c?.slug === "figma");
        if (live) setConnection(connected ? "connected" : "not_connected");
      } catch {
        if (live) setConnection("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [active]);
  return connection;
}

export function _resetBuildFigmaFrameForTests(): void {
  set({ frame: null, note: null });
}
