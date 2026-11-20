export type OrganicTrialPost = { id: string; publishedAt: string | null };
export type OrganicTrialMetric = { id: string; replies: number | null };
export type OrganicTrialEvaluationInput = {
  posts: readonly OrganicTrialPost[];
  metrics: readonly OrganicTrialMetric[];
  fetchedAt: string | null;
  now: number;
  days?: number;
};

export type OrganicTrialEvaluation =
  | { kind: "waiting_publication"; dueAt: null }
  | { kind: "waiting_window"; dueAt: string }
  | { kind: "waiting_metrics"; dueAt: string }
  | { kind: "no_replies"; dueAt: string; observedAt: string }
  | {
    kind: "winner";
    dueAt: string;
    observedAt: string;
    winner: { id: string; replies: number };
    tiedIds: string[];
  };

const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function timestamp(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function evaluateTrial(input: OrganicTrialEvaluationInput): OrganicTrialEvaluation {
  const { posts, metrics, fetchedAt, now, days = 3 } = input;
  const unpublished = { kind: "waiting_publication", dueAt: null } as const;
  if (!Number.isFinite(now) || Math.abs(now) > MAX_DATE_MS || !Number.isSafeInteger(days) || days < 1)
    return unpublished;
  if (posts.length !== 3) return unpublished;
  const ids = new Set<string>();
  let lastPublished = -Infinity;
  for (const post of posts) {
    if (typeof post.id !== "string" || !post.id || post.id.trim() !== post.id || ids.has(post.id)) return unpublished;
    const published = timestamp(post.publishedAt);
    if (published === null || published > now) return unpublished;
    ids.add(post.id);
    lastPublished = Math.max(lastPublished, published);
  }
  const dueMs = lastPublished + days * DAY_MS;
  if (!Number.isFinite(dueMs) || Math.abs(dueMs) > MAX_DATE_MS) return unpublished;
  const dueAt = new Date(dueMs).toISOString();
  if (now < dueMs) return { kind: "waiting_window", dueAt };

  const observedMs = timestamp(fetchedAt);
  if (observedMs === null || observedMs < dueMs || observedMs > now) return { kind: "waiting_metrics", dueAt };
  const measured = new Map<string, number>();
  for (const metric of metrics) {
    if (!ids.has(metric.id)) continue;
    if (measured.has(metric.id) || typeof metric.replies !== "number" || !Number.isSafeInteger(metric.replies) || metric.replies < 0)
      return { kind: "waiting_metrics", dueAt };
    measured.set(metric.id, metric.replies);
  }
  if (measured.size !== 3) return { kind: "waiting_metrics", dueAt };
  const observedAt = new Date(observedMs).toISOString();
  const best = Math.max(...measured.values());
  if (best === 0) return { kind: "no_replies", dueAt, observedAt };
  const tied = [...measured].filter(([, replies]) => replies === best).map(([id]) => id).sort();
  return {
    kind: "winner", dueAt, observedAt,
    winner: { id: tied[0], replies: best },
    tiedIds: tied.length > 1 ? tied : [],
  };
}
