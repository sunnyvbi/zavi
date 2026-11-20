"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryApi } from "@/lib/memory/writesApi";

export const UNDO_WINDOW_MS = 10_000;

export type ForgetMode = "forgetting" | "forgotten" | "undoing" | "undo_failed" | "gone" | "error";

export const HIDDEN_MODES: ReadonlySet<string> = new Set(["forgetting", "forgotten", "undoing", "undo_failed"]);
export const UNDOABLE_MODES: ReadonlySet<string> = new Set(["forgotten", "undo_failed"]);

export const FORGET_NOTES: Readonly<Record<string, string>> = {
  forgetting: "Forgetting…",
  forgotten: "Forgotten",
  undoing: "Restoring…",
  undo_failed: "Could not undo. Try again.",
  error: "Could not forget this. Try again.",
};

type Op ={ token: string; deadline: number; timer?: ReturnType<typeof setTimeout> };

export function useForgetWithUndo(api: MemoryApi, onGone?: (noteId: string) => void) {
  const [modes, setModes] = useState<Record<string, ForgetMode>>({});
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const ops = useRef(new Map<string, Op>());
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  useEffect(() => {
    const all = ops.current;
    return () => all.forEach((op) => clearTimeout(op.timer));
  }, []);

  const set = useCallback((id: string, mode: ForgetMode | null) => {
    setModes((prev) => {
      const next = { ...prev };
      if (mode) next[id] = mode;
      else delete next[id];
      return next;
    });
  }, []);

  const arm = useCallback(
    (noteId: string, op: Op) => {
      clearTimeout(op.timer);
      op.timer = setTimeout(() => {
        ops.current.delete(noteId);
        set(noteId, "gone");
        onGoneRef.current?.(noteId);
      }, Math.max(0, op.deadline - Date.now()));
    },
    [set],
  );

  const forget = useCallback(
    async (noteId: string) => {
      const m = modesRef.current[noteId];
      if (m && HIDDEN_MODES.has(m)) return;
      set(noteId, "forgetting");
      let token: string;
      try {
        token = (await api.forget(noteId)).undo_token;
      } catch {
        set(noteId, "error");
        return;
      }
      const op: Op = { token, deadline: Date.now() + UNDO_WINDOW_MS };
      ops.current.set(noteId, op);
      set(noteId, "forgotten");
      arm(noteId, op);
    },
    [api, set, arm],
  );

  const undo = useCallback(
    async (noteId: string) => {
      const op = ops.current.get(noteId);
      const m = modesRef.current[noteId];
      if (!op || !m || !UNDOABLE_MODES.has(m)) return;
      clearTimeout(op.timer);
      set(noteId, "undoing");
      try {
        if (!op.token) throw new Error("no undo token");
        await api.undoForget(op.token);
        ops.current.delete(noteId);
        set(noteId, null);
      } catch {
        set(noteId, "undo_failed");
        arm(noteId, op);
      }
    },
    [api, set, arm],
  );

  return { modes, forget, undo };
}
