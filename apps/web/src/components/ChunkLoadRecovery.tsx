"use client";

import { useEffect } from "react";
import {
  NEXT_CHUNK_RELOAD_STORAGE_KEY,
  isNextChunkLoadFailure,
  shouldReloadForChunkFailure,
} from "@/lib/chunkLoadRecovery";

const MIN_RELOAD_INTERVAL_MS = 30_000;

function eventTargetChunkSource(target: EventTarget | null): string {
  if (target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  return "";
}

function reloadOnceForFreshBuild() {
  try {
    const now = Date.now();
    const lastReloadAt = window.sessionStorage.getItem(NEXT_CHUNK_RELOAD_STORAGE_KEY);
    if (!shouldReloadForChunkFailure(now, lastReloadAt, MIN_RELOAD_INTERVAL_MS)) {
      return;
    }
    window.sessionStorage.setItem(NEXT_CHUNK_RELOAD_STORAGE_KEY, String(now));
  } catch {
    return;
  }

  window.location.reload();
}

export function ChunkLoadRecovery(): null {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      const resourceSource = eventTargetChunkSource(event.target);
      if (
        isNextChunkLoadFailure(resourceSource) ||
        isNextChunkLoadFailure({
          name: event.error?.name,
          message: event.message || event.error?.message,
          stack: event.error?.stack,
          filename: event.filename,
        })
      ) {
        reloadOnceForFreshBuild();
      }
    }

    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      if (isNextChunkLoadFailure(event.reason)) {
        reloadOnceForFreshBuild();
      }
    }

    window.addEventListener("error", handleError, true);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError, true);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
}
