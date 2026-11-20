
export type CreatorBadge = "top_creator" | "responds_fast";

export type CreatorReviewItem = {
  id: string;
  order_id: string;
  business_name: string;
  communication: number;
  timeliness: number;
  satisfaction: number;
  body: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatorReviewAggregates = {
  review_count: number;
  avg_communication: number | null;
  avg_timeliness: number | null;
  avg_satisfaction: number | null;
  avg_overall: number | null;
};

export type CreatorReputation = {
  aggregates: CreatorReviewAggregates;
  completed_job_count: number;
  responds_fast: {
    computable: boolean;
    requests_counted: number;
    answered_within_window: number;
    share_within_window: number | null;
  };
  badges: CreatorBadge[];
  display_state: "new_to_zavi" | "rated";
  reviews: CreatorReviewItem[];
};

export const BADGE_LABEL: Record<CreatorBadge, string> = {
  top_creator: "Top Creator",
  responds_fast: "Responds Fast",
};

export const BADGE_EXPLANATION: Record<CreatorBadge, string> = {
  top_creator: "3 or more completed jobs, rated 4.5 or higher on average.",
  responds_fast: "Answers most booking requests within 24 hours.",
};

export type RatingHeadline =
  | { kind: "new_to_zavi"; label: string }
  | {
      kind: "rated";
      score: string;
      reviewCount: number;
      countLabel: string;
      label: string;
    };

export function ratingHeadline(aggregates: CreatorReviewAggregates): RatingHeadline {
  if (aggregates.review_count === 0 || aggregates.avg_overall === null) {
    return { kind: "new_to_zavi", label: "New to Zavi" };
  }
  const score = aggregates.avg_overall.toFixed(1);
  const noun = aggregates.review_count === 1 ? "review" : "reviews";
  return {
    kind: "rated",
    score,
    reviewCount: aggregates.review_count,
    countLabel: `out of 5, from ${aggregates.review_count} ${noun}`,
    label: `${score} from ${aggregates.review_count} ${noun}`,
  };
}

export function dimensionLines(
  aggregates: CreatorReviewAggregates,
): Array<{ label: string; value: string }> {
  if (aggregates.review_count === 0) return [];
  const rows: Array<{ label: string; value: number | null }> = [
    { label: "Communication", value: aggregates.avg_communication },
    { label: "Timeliness", value: aggregates.avg_timeliness },
    { label: "Satisfaction", value: aggregates.avg_satisfaction },
  ];
  return rows
    .filter((r): r is { label: string; value: number } => r.value !== null)
    .map((r) => ({ label: r.label, value: r.value.toFixed(1) }));
}

export function reviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
