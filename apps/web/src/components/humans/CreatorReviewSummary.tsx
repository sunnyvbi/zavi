"use client";

import { HumanCard, HumanChip, HumanSectionHeading } from "./HumanStates";
import {
  BADGE_EXPLANATION,
  BADGE_LABEL,
  dimensionLines,
  ratingHeadline,
  reviewDate,
  type CreatorBadge,
  type CreatorReviewAggregates,
  type CreatorReviewItem,
} from "./creatorReviewDisplay";

export function CreatorBadges({ badges }: { badges: CreatorBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {badges.map((b) => (
        <span key={b} title={BADGE_EXPLANATION[b]}>
          <HumanChip tone="ok">{BADGE_LABEL[b]}</HumanChip>
        </span>
      ))}
    </div>
  );
}

export function CreatorRating({ aggregates }: { aggregates: CreatorReviewAggregates }) {
  const headline = ratingHeadline(aggregates);

  if (headline.kind === "new_to_zavi") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <HumanChip tone="info">{headline.label}</HumanChip>
        <span className="text-[13px] leading-[1.5] text-inkMuted">
          No reviews yet. This creator has not finished a job on Zavi.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-[20px] font-semibold leading-7 text-ink">{headline.score}</span>
      <span className="text-[13px] leading-[1.5] text-inkMuted">{headline.countLabel}</span>
    </div>
  );
}

function DimensionAverages({ aggregates }: { aggregates: CreatorReviewAggregates }) {
  const lines = dimensionLines(aggregates);
  if (lines.length === 0) return null;
  return (
    <dl className="mt-3 grid grid-cols-3 gap-3">
      {lines.map((l) => (
        <div key={l.label}>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-inkMuted">
            {l.label}
          </dt>
          <dd className="mt-0.5 text-[16px] font-semibold leading-5 text-ink">{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CreatorReviewList({ reviews }: { reviews: CreatorReviewItem[] }) {
  if (reviews.length === 0) return null;
  return (
    <ul className="mt-4 space-y-3">
      {reviews.map((r) => (
        <li key={r.id} className="border-t border-ink/[0.08] pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            {}
            <span className="text-[13px] font-semibold leading-5 text-ink">
              {r.business_name}
            </span>
            <span className="text-[12px] leading-5 text-inkMuted">
              {reviewDate(r.created_at)}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] leading-[1.5] text-inkMuted">
            Communication {r.communication} · Timeliness {r.timeliness} · Satisfaction{" "}
            {r.satisfaction}
          </p>
          {r.body ? (
            <p className="mt-1.5 text-[13px] leading-[1.55] text-ink">{r.body}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function CreatorReviewSummary({
  aggregates,
  badges,
  reviews,
}: {
  aggregates: CreatorReviewAggregates;
  badges: CreatorBadge[];
  reviews: CreatorReviewItem[];
}) {
  return (
    <HumanCard>
      <HumanSectionHeading right={<CreatorBadges badges={badges} />}>Reviews</HumanSectionHeading>
      <div className="mt-3">
        <CreatorRating aggregates={aggregates} />
      </div>
      <DimensionAverages aggregates={aggregates} />
      <CreatorReviewList reviews={reviews} />
    </HumanCard>
  );
}
