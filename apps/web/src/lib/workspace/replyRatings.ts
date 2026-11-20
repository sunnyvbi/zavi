import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "./sessionScopedCache";

export type ReplyRating = -1 | 1;

const BATCH_MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new Map<string, ReplyRating | null>();
const waiting = new Map<string, Array<(v: ReplyRating | null) => void>>();
let queued: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

async function flush(): Promise<void> {
  timer = null;
  const gen = generation;
  const ids = [...new Set(queued)];
  queued = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const chunk = ids.slice(i, i + BATCH_MAX);
    let ratings: Record<string, { rating?: unknown }> | null = null;
    try {
      const res = await apiFetch(`/api/feedback/mine?target_type=agent_run&ids=${chunk.join(",")}`);
      const body = res.ok ? ((await res.json().catch(() => null)) as { ratings?: unknown } | null) : null;
      ratings = body && typeof body.ratings === "object" && body.ratings !== null ? (body.ratings as Record<string, { rating?: unknown }>) : null;
    } catch {
      ratings = null;
    }
    if (gen !== generation) return;
    for (const id of chunk) {
      const r = ratings?.[id]?.rating;
      const v: ReplyRating | null = r === 1 || r === -1 ? r : null;
      if (ratings && !cache.has(id)) cache.set(id, v);
      for (const cb of waiting.get(id) ?? []) cb(cache.has(id) ? cache.get(id) ?? null : v);
      waiting.delete(id);
    }
  }
}

export function readReplyRating(id: string, cb: (v: ReplyRating | null) => void): () => void {
  if (cache.has(id) || !UUID_RE.test(id)) {
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

export function rememberReplyRating(id: string, rating: ReplyRating): void {
  cache.set(id, rating);
}

export function resetReplyRatings(): void {
  generation += 1;
  cache.clear();
  waiting.clear();
  queued = [];
  if (timer) clearTimeout(timer);
  timer = null;
}

registerSessionScopedCache(resetReplyRatings);
