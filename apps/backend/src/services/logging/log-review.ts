
import { logEvent } from "./logEvent";

export interface LogReviewInput {
  feature: string;
  event: string;
  outcome: string;
  run_id: string;
  tenant_id?: string | null;
  meta?: Record<string, string | number | undefined>;
}

function sanitizeSlug(s: string): string {
  const slug = (s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return slug || "unknown";
}

export function logReview(input: LogReviewInput): void {
  const feature = sanitizeSlug(input.feature);
  const event = sanitizeSlug(input.event);
  const outcome = sanitizeSlug(input.outcome);
  void logEvent({
    level: "info",
    source: "review",
    code: `review.${feature}.${event}`,
    run_id: input.run_id,
    tenant_id: input.tenant_id ?? undefined,
    meta: { ...input.meta, review_outcome: outcome },
  });
}
