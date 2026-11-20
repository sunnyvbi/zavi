"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { cx, FOCUS_RING, MESSAGE_ACTION_BUTTON, MESSAGE_ACTION_ICON } from "../layout/shared";

export type BuildRatingValue = -1 | 1;
type Saved = { rating: BuildRatingValue | null; comment: string | null; reasons: BuildReasonId[] };

export const RATING_REASON_PLACEHOLDER = "What was off? (optional)";
export const RATING_THANKS_CARRYOVER = "Thanks. Your next change will avoid this.";
export const BUILD_REASON_OPTIONS = [
  { id: "look", label: "Look or colours" },
  { id: "layout", label: "Layout" },
  { id: "copy", label: "Wrong words or facts" },
  { id: "missing", label: "Missing section" },
  { id: "broken", label: "Something broken" },
  { id: "slow", label: "Slow" },
] as const;
export type BuildReasonId = (typeof BUILD_REASON_OPTIONS)[number]["id"];
export const RATING_SAVE_FAILED = "Couldn't save your rating. Try again.";
const REASON_MAX = 500;
const BATCH_MAX = 50;
const BUILD_REASON_IDS = new Set<string>(BUILD_REASON_OPTIONS.map((option) => option.id));

function savedReasons(value: unknown): BuildReasonId[] {
  return Array.isArray(value) ? value.filter((reason): reason is BuildReasonId => typeof reason === "string" && BUILD_REASON_IDS.has(reason)) : [];
}

const cache = new Map<string, Saved | null>();
const waiting = new Map<string, Array<(v: Saved | null) => void>>();
let queued: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let cacheGeneration = 0;

async function flush(): Promise<void> {
  timer = null;
  const generation = cacheGeneration;
  const ids = [...new Set(queued)];
  queued = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const chunk = ids.slice(i, i + BATCH_MAX);
    let ratings: Record<string, Saved> | null = null;
    try {
      const res = await apiFetch(`/api/feedback/mine?target_type=conductor_run&ids=${chunk.join(",")}`);
      const body = res.ok ? ((await res.json().catch(() => null)) as { ratings?: Record<string, Omit<Saved, "reasons"> & { reasons?: unknown }> } | null) : null;
      ratings = body && typeof body.ratings === "object" && body.ratings !== null
        ? Object.fromEntries(Object.entries(body.ratings).map(([id, value]) => [id, { ...value, reasons: savedReasons(value.reasons) }]))
        : null;
    } catch {
      ratings = null;
    }
    if (generation !== cacheGeneration) return;
    for (const id of chunk) {
      const v = ratings?.[id] ?? null;
      if (ratings) cache.set(id, v);
      for (const cb of waiting.get(id) ?? []) cb(v);
      waiting.delete(id);
    }
  }
}

function readSaved(id: string, cb: (v: Saved | null) => void): () => void {
  if (cache.has(id)) {
    cb(cache.get(id) ?? null);
    return () => undefined;
  }
  const list = waiting.get(id) ?? [];
  list.push(cb);
  waiting.set(id, list);
  queued.push(id);
  if (!timer) timer = setTimeout(() => void flush(), 0);
  return () => {
    const l = waiting.get(id);
    if (l) waiting.set(id, l.filter((x) => x !== cb));
  };
}

export function resetBuildRatingCache(): void {
  cacheGeneration += 1;
  cache.clear();
  waiting.clear();
  queued = [];
  if (timer) clearTimeout(timer);
  timer = null;
}

registerSessionScopedCache(resetBuildRatingCache);

async function save(
  runId: string,
  rating: BuildRatingValue,
  comment: string | null,
  reasons: BuildReasonId[],
): Promise<{ ok: boolean; carryover: boolean }> {
  try {
    const res = await apiFetch("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ target_type: "conductor_run", target_id: runId, rating, comment, reasons }),
    });
    if (!res.ok) return { ok: false, carryover: false };
    const body = (await res.json().catch(() => null)) as { carryover?: unknown } | null;
    return { ok: true, carryover: body?.carryover === true };
  } catch {
    return { ok: false, carryover: false };
  }
}

const CHIP =
  "inline-flex min-h-[32px] items-center rounded-full border px-3 py-1 text-[12px] transition-colors disabled:opacity-60";

export function BuildRating({ runId, label }: { runId: string; label: "build" | "change" }) {
  const [rating, setRating] = useState<BuildRatingValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<BuildReasonId[]>([]);
  const [thanks, setThanks] = useState<string | null>(null);
  const touched = useRef(false);
  const inFlight = useRef(false);
  const savedComment = useRef<string | null>(null);
  const savedPicked = useRef<BuildReasonId[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    touched.current = false;
    inFlight.current = false;
    savedComment.current = null;
    savedPicked.current = [];
    setRating(null);
    setBusy(false);
    setError(null);
    setAsking(false);
    setReason("");
    setPicked([]);
    setThanks(null);
    return readSaved(runId, (v) => {
      if (touched.current || !v?.rating) return;
      savedComment.current = v.comment ?? null;
      savedPicked.current = v.reasons;
      setRating(v.rating);
    });
  }, [runId]);

  const rate = async (next: BuildRatingValue) => {
    if (inFlight.current) return;
    if (next === rating) {
      if (next === -1 && !asking) {
        setThanks(null);
        setError(null);
        setPicked(savedPicked.current);
        setReason(savedComment.current ?? "");
        setAsking(true);
      }
      return;
    }
    inFlight.current = true;
    const gen = generation.current;
    touched.current = true;
    const before = rating;
    setRating(next);
    setError(null);
    setThanks(null);
    setAsking(next === -1);
    setPicked([]);
    if (next === 1) setReason("");
    setBusy(true);
    const comment = next === -1 && reason.trim() ? reason.trim().slice(0, REASON_MAX) : null;
    const { ok } = await save(runId, next, comment, []);
    if (gen !== generation.current) return;
    inFlight.current = false;
    setBusy(false);
    if (!ok) {
      setRating(before);
      setAsking(false);
      setError(RATING_SAVE_FAILED);
      return;
    }
    savedComment.current = comment;
    savedPicked.current = [];
    cache.set(runId, { rating: next, comment, reasons: [] });
    if (next === 1) setThanks(null);
  };

  const toggle = (id: BuildReasonId) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : BUILD_REASON_OPTIONS.map((o) => o.id).filter((x) => x === id || cur.includes(x))));

  const sendReason = async (e: FormEvent) => {
    e.preventDefault();
    const text = reason.trim().slice(0, REASON_MAX);
    if ((!text && picked.length === 0) || inFlight.current) return;
    inFlight.current = true;
    const gen = generation.current;
    const reasons = picked;
    setBusy(true);
    setError(null);
    const { ok, carryover } = await save(runId, -1, text || null, reasons);
    if (gen !== generation.current) return;
    inFlight.current = false;
    setBusy(false);
    if (!ok) {
      setError(RATING_SAVE_FAILED);
      return;
    }
    savedComment.current = text || null;
    savedPicked.current = reasons;
    cache.set(runId, { rating: -1, comment: text || null, reasons });
    setAsking(false);
    setThanks(reasons.length > 0 && carryover ? RATING_THANKS_CARRYOVER : null);
  };

  const what = label === "build" ? "this build" : "this change";
  return (
    <>
      <span className="inline-flex items-center gap-0.5" data-testid="build-rating" data-rating={rating ?? ""}>
        <button
          type="button"
          onClick={() => void rate(1)}
          disabled={busy}
          aria-pressed={rating === 1}
          aria-label={`Good ${label}`}
          title={`Rate ${what} good`}
          className={cx(MESSAGE_ACTION_BUTTON, rating === 1 ? "text-ink" : "text-inkMuted", "disabled:opacity-60", FOCUS_RING)}
        >
          <ThumbsUp aria-hidden {...MESSAGE_ACTION_ICON} fill={rating === 1 ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={() => void rate(-1)}
          disabled={busy}
          aria-pressed={rating === -1}
          aria-label={`Bad ${label}`}
          title={`Rate ${what} bad`}
          className={cx(MESSAGE_ACTION_BUTTON, rating === -1 ? "text-ink" : "text-inkMuted", "disabled:opacity-60", FOCUS_RING)}
        >
          <ThumbsDown aria-hidden {...MESSAGE_ACTION_ICON} fill={rating === -1 ? "currentColor" : "none"} />
        </button>
        {thanks && !asking && (
          <span role="status" className="ml-1 text-[12px] text-inkMuted">
            {thanks}
          </span>
        )}
      </span>
      {asking && (
        <form onSubmit={(e) => void sendReason(e)} className="mt-1 flex w-full basis-full flex-col gap-2" data-testid="build-rating-reason">
          <div role="group" aria-label="What was off (pick any)" className="flex flex-wrap gap-1.5" data-testid="build-rating-chips">
            {BUILD_REASON_OPTIONS.map((o) => {
              const on = picked.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggle(o.id)}
                  disabled={busy}
                  aria-pressed={on}
                  className={cx(CHIP, on ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-inkMuted hover:text-ink", FOCUS_RING)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <div className="flex w-full items-center gap-2">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              placeholder={RATING_REASON_PLACEHOLDER}
              aria-label={`What was off with ${what}?`}
              autoFocus
              className={cx("min-w-0 flex-1 rounded-lg border border-rule bg-cream px-3 py-1.5 text-[13px] text-ink placeholder:text-inkMuted", FOCUS_RING)}
            />
            <button
              type="submit"
              disabled={busy || (!reason.trim() && picked.length === 0)}
              className={cx("shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-cream disabled:opacity-50", FOCUS_RING)}
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className={cx("shrink-0 rounded-full px-2 py-1.5 text-[12px] text-inkMuted hover:text-ink", FOCUS_RING)}
            >
              Skip
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-1 basis-full text-[12px] text-danger">
          {error}
        </p>
      )}
    </>
  );
}
