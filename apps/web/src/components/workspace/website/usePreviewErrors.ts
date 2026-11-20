import { useEffect, useRef, useState, type RefObject } from "react";
import { originOf } from "../home/previewPicker";
import {
  PREVIEW_ERRORS_HELLO,
  PREVIEW_ERRORS_READY,
  errorKey,
  parsePreviewErrorsMessage,
  type PreviewError,
} from "./previewErrors";

export type TrackedPreviewError = PreviewError & { seenAt: number };

type SeenError = { count: number; shown: number; seenAt: number };

export function collapsedCount(before: SeenError | undefined, count: number, replay: boolean): number {
  if (!before) return replay ? count : 1;
  if (count > before.count) return before.shown + 1;
  if (count < before.count) return Math.min(before.shown, count);
  return before.shown;
}

export function usePreviewErrors(
  frameRef: RefObject<HTMLIFrameElement | null>,
  src: string | null | undefined,
): TrackedPreviewError[] {
  const [errors, setErrors] = useState<TrackedPreviewError[]>([]);
  const seenRef = useRef(new Map<string, SeenError>());
  const replayRef = useRef(true);

  useEffect(() => {
    seenRef.current = new Map();
    replayRef.current = true;
    setErrors([]);
    const origin = src ? originOf(src) : null;
    if (!origin) return;
    const hello = () => {
      try {
        frameRef.current?.contentWindow?.postMessage({ type: PREVIEW_ERRORS_HELLO }, origin);
      } catch {
        return;
      }
    };
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== origin) return;
      const data = event.data as { type?: unknown } | null;
      if (data && data.type === PREVIEW_ERRORS_READY) {
        seenRef.current = new Map();
        replayRef.current = true;
        setErrors([]);
        hello();
        return;
      }
      const parsed = parsePreviewErrorsMessage(event.data);
      if (!parsed) return;
      const now = Date.now();
      const prior = seenRef.current;
      const replay = replayRef.current;
      replayRef.current = false;
      const next = new Map<string, SeenError>();
      const tracked = parsed.map((error) => {
        const key = errorKey(error);
        const before = prior.get(key);
        const seenAt = before && before.count >= error.count ? before.seenAt : now;
        const shown = collapsedCount(before, error.count, replay);
        next.set(key, { count: error.count, shown, seenAt });
        return { ...error, count: shown, seenAt };
      });
      seenRef.current = next;
      setErrors(tracked);
    };
    window.addEventListener("message", onMessage);
    hello();
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, src]);

  return errors;
}
