import { isTerminalBuildRun } from "./logic";

export type BuildRatingValue = -1 | 1;

export const BUILD_REASON_OPTIONS = [
  { id: "look", label: "Look or colours" },
  { id: "layout", label: "Layout" },
  { id: "copy", label: "Wrong words or facts" },
  { id: "missing", label: "Missing section" },
  { id: "broken", label: "Something broken" },
  { id: "slow", label: "Slow" },
] as const;
export type BuildReasonId = (typeof BUILD_REASON_OPTIONS)[number]["id"];

export const RATING_REASON_PLACEHOLDER = "What was off? (optional)";
export const RATING_THANKS_CARRYOVER = "Thanks. Your next change will avoid this.";
export const RATING_SAVE_FAILED = "Couldn't save your rating. Try again.";
export const REASON_MAX = 500;
export const RATINGS_BATCH_MAX = 50;

export type SavedRating = { rating: BuildRatingValue | null; comment: string | null; reasons: BuildReasonId[] };

const REASON_IDS = new Set<string>(BUILD_REASON_OPTIONS.map((o) => o.id));

export function ratingBody(
  runId: string,
  rating: BuildRatingValue,
  comment: string | null,
  reasons: BuildReasonId[],
): Record<string, unknown> {
  const text = (comment ?? "").trim().slice(0, REASON_MAX);
  return {
    target_type: "conductor_run",
    target_id: runId,
    rating,
    comment: text || null,
    reasons: rating === -1 ? reasons : [],
  };
}

export function toggleReason(picked: BuildReasonId[], id: BuildReasonId): BuildReasonId[] {
  if (picked.includes(id)) return picked.filter((x) => x !== id);
  return BUILD_REASON_OPTIONS.map((o) => o.id).filter((x) => x === id || picked.includes(x));
}

export function thanksLine(reasons: BuildReasonId[], carryover: unknown): string | null {
  return reasons.length > 0 && carryover === true ? RATING_THANKS_CARRYOVER : null;
}

export function readSavedRatings(body: unknown): Record<string, SavedRating> {
  const ratings = (body as { ratings?: unknown } | null)?.ratings;
  if (!ratings || typeof ratings !== "object") return {};
  const out: Record<string, SavedRating> = {};
  for (const [id, raw] of Object.entries(ratings as Record<string, unknown>)) {
    const v = (raw ?? {}) as { rating?: unknown; comment?: unknown; reasons?: unknown };
    const rating = v.rating === 1 || v.rating === -1 ? v.rating : null;
    out[id] = {
      rating,
      comment: typeof v.comment === "string" ? v.comment : null,
      reasons: Array.isArray(v.reasons)
        ? v.reasons.filter((r): r is BuildReasonId => typeof r === "string" && REASON_IDS.has(r))
        : [],
    };
  }
  return out;
}

export function canRateRefine(r: { status: string; kind?: string }): boolean {
  if (r.kind === "undo" || r.kind === "restore") return false;
  return isTerminalBuildRun(r.status) && r.status !== "paused";
}
