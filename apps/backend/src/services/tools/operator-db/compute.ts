
import type { CanonicalMap, CanonicalMapEntry } from "./mapping";
import type { MetricResult } from "./metric-contract";
import { checkMetricContract } from "./metric-contract";
import { bucketReasonCounts, categoryShare, DEFAULT_MIN_COUNT, type ReasonBucket } from "./kanon";
import type { LeverCandidate, SourceQuality } from "./ranking";

export interface MetricRunner {
  count(collection: string, filter?: Record<string, unknown>): Promise<number>;
  distinctCount(collection: string, field: string, filter?: Record<string, unknown>): Promise<number>;
  distinctJoinMatched(
    collection: string,
    field: string,
    refCollection: string,
    refField: string,
    filter?: Record<string, unknown>,
  ): Promise<{ matched: number; attempted: number; unavailable?: boolean }>;
  groupCount(
    collection: string,
    field: string,
    filter?: Record<string, unknown>,
  ): Promise<{ groups: { value: unknown; count: number }[]; truncated: boolean }>;
}

export type ComputeInput = {
  map: CanonicalMap;
  dialect: string;
  window_days: number;
  runner: MetricRunner | null;
  minCount?: number;
};

export type ComputeOutput = {
  candidates: LeverCandidate[];
  metrics: { lever: string; result: MetricResult }[];
};

function entry(map: CanonicalMap, role: string): CanonicalMapEntry | undefined {
  const e = map[role];
  return e && typeof e === "object" ? e : undefined;
}

function windowFilter(field: string, windowDays: number, nowMs: number): Record<string, unknown> {
  const thresholdMs = nowMs - windowDays * 86400000;
  const asDate = new Date(thresholdMs);
  const asIso = asDate.toISOString();
  const MS_BOUNDARY = 1_000_000_000_000;
  return {
    $or: [
      { [field]: { $gte: asDate } },
      { [field]: { $gte: asIso } },
      { [field]: { $gte: thresholdMs } },
      { [field]: { $gte: Math.floor(thresholdMs / 1000), $lt: MS_BOUNDARY } },
    ],
  };
}

function reasonPresent(field: string): Record<string, unknown> {
  return { [field]: { $nin: [null, ""] } };
}

async function computeIdleSupply(
  input: ComputeInput,
  nowMs: number,
): Promise<{ candidate: LeverCandidate; metric?: MetricResult }> {
  const constraint = "idle-supply";
  const listings = entry(input.map, "listings");
  const bookings = entry(input.map, "bookings");
  const listingRef = bookings?.listing_ref_field;
  const createdAt = bookings?.created_at_field;
  const listingId = listings?.id_field;

  if (!input.runner || !listings?.table || !bookings?.table || !listingRef || !createdAt || !listingId) {
    return {
      candidate: baseCandidate(constraint, input, {
        abstain_reason: "no_data",
      }),
    };
  }

  const r = input.runner;
  const wf = windowFilter(createdAt, input.window_days, nowMs);
  const totalListings = await r.count(listings.table);
  const join = await r.distinctJoinMatched(bookings.table, listingRef, listings.table, listingId, wf);
  if (join.unavailable) {
    return { candidate: baseCandidate(constraint, input, { abstain_reason: "join_unavailable" }) };
  }
  const bookedMatched = join.matched;
  const bookedAttempted = join.attempted;
  const bookingsInWindow = await r.count(bookings.table, wf);
  const nullRefs = await r.count(bookings.table, { ...wf, [listingRef]: null });

  const idle = Math.max(0, totalListings - bookedMatched);
  const metric: MetricResult = {
    lever: constraint,
    numerator: idle,
    denominator: totalListings,
    window_days: input.window_days,
    numerator_window_days: input.window_days,
    denominator_window_days: input.window_days,
    join_matched: bookedMatched,
    join_attempted: bookedAttempted,
    null_count: nullRefs,
    sampled_count: bookingsInWindow,
    independent_denominator: totalListings,
    query_id: "idle-supply:listings-vs-booked",
    source: `${listings.table}+${bookings.table}`,
  };
  const verdict = checkMetricContract(metric);
  return {
    candidate: baseCandidate(constraint, input, {
      numerator: idle,
      denominator: totalListings,
      metric_probe_passed: verdict.passed,
      k_anon_passed: true,
      query_id: metric.query_id,
      elasticity_hint: "Reactivating idle listings is usually mid-effort (host nudge / delist-relist).",
      build_cost_hint: "Low: reactivation campaign, no new surface.",
    }),
    metric,
  };
}

async function computeCancelLeak(
  input: ComputeInput,
  nowMs: number,
): Promise<{ candidate: LeverCandidate; metric?: MetricResult; buckets?: ReasonBucket[] }> {
  const constraint = "verification-cancel-leak";
  const cancels = entry(input.map, "cancellations");
  const bookings = entry(input.map, "bookings");
  const reasonField = cancels?.reason_field;
  const cancelCreatedAt = cancels?.created_at_field ?? bookings?.created_at_field;
  const bookingCreatedAt = bookings?.created_at_field;

  if (!input.runner || !cancels?.table || !reasonField || !cancelCreatedAt || !bookings?.table || !bookingCreatedAt) {
    return {
      candidate: baseCandidate(constraint, input, {
        abstain_reason: "no_cancellation_mapping",
      }),
    };
  }

  const r = input.runner;
  const cwf = { ...windowFilter(cancelCreatedAt, input.window_days, nowMs), ...reasonPresent(reasonField) };
  const bwf = windowFilter(bookingCreatedAt, input.window_days, nowMs);

  const { groups: reasonCounts, truncated } = await r.groupCount(cancels.table, reasonField, cwf);

  if (truncated) {
    return {
      candidate: baseCandidate(constraint, input, { abstain_reason: "reason_field_truncated" }),
    };
  }

  const minCount = input.minCount ?? DEFAULT_MIN_COUNT;
  const buckets = bucketReasonCounts(reasonCounts, minCount);
  const share = categoryShare(buckets, "verification");
  const bookingsInWindow = await r.count(bookings.table, bwf);
  const totalReasoned = reasonCounts.reduce((a, b) => a + (b.count > 0 ? b.count : 0), 0);

  if (!share) {
    return {
      candidate: baseCandidate(constraint, input, {
        k_anon_passed: false,
        abstain_reason: "k_anon_below_threshold",
      }),
      buckets,
    };
  }

  const metric: MetricResult = {
    lever: constraint,
    numerator: share.count,
    denominator: bookingsInWindow,
    window_days: input.window_days,
    numerator_window_days: input.window_days,
    denominator_window_days: input.window_days,
    null_count: 0,
    sampled_count: totalReasoned,
    query_id: "verification-cancel-leak:reason-buckets",
    source: `${cancels.table}+${bookings.table}`,
  };
  const verdict = checkMetricContract(metric);
  return {
    candidate: baseCandidate(constraint, input, {
      numerator: share.count,
      denominator: bookingsInWindow,
      metric_probe_passed: verdict.passed,
      k_anon_passed: true,
      query_id: metric.query_id,
      elasticity_hint: "Verification-driven cancels are high-elasticity: a smoother verify flow directly recovers bookings.",
      build_cost_hint: "Medium: verification UX + policy change.",
    }),
    metric,
    buckets,
  };
}

function abstainUnmappable(input: ComputeInput): LeverCandidate[] {
  return [
    baseCandidate("thin-funnel", input, { abstain_reason: "no_data" }),
    baseCandidate("attempt-to-conversion", input, { abstain_reason: "no_data" }),
  ];
}

function baseCandidate(
  constraint: string,
  input: ComputeInput,
  over: Partial<LeverCandidate>,
): LeverCandidate {
  const isMongo = input.dialect === "mongodb" && !!input.runner;
  const source_quality: SourceQuality = isMongo ? "confirmed_live_mongo" : "synthetic_only";
  return {
    constraint,
    numerator: 0,
    denominator: 0,
    source_quality,
    confirmed_map: true,
    metric_probe_passed: false,
    k_anon_passed: true,
    live_validated: isMongo,
    ...over,
  };
}

export async function computeLevers(input: ComputeInput, nowMs: number): Promise<ComputeOutput> {
  if (input.dialect !== "mongodb" || !input.runner) {
    const candidates = [
      baseCandidate("idle-supply", input, { abstain_reason: "requires_sql_validation" }),
      baseCandidate("verification-cancel-leak", input, { abstain_reason: "requires_sql_validation" }),
      ...abstainUnmappable(input),
    ];
    return { candidates, metrics: [] };
  }

  const idle = await computeIdleSupply(input, nowMs);
  const cancel = await computeCancelLeak(input, nowMs);
  const candidates = [idle.candidate, cancel.candidate, ...abstainUnmappable(input)];
  const metrics = [
    ...(idle.metric ? [{ lever: idle.candidate.constraint, result: idle.metric }] : []),
    ...(cancel.metric ? [{ lever: cancel.candidate.constraint, result: cancel.metric }] : []),
  ];
  return { candidates, metrics };
}
