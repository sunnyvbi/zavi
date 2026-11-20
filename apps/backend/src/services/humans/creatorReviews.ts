
import { asTenantId, tenantClient, staffCrossTenantClient } from "@/services/tenant-client";
import { loadHumanMemberByAuthUser } from "@/services/humans/member";

export const REVIEW_EDIT_WINDOW_DAYS = 7;

export const TOP_CREATOR_MIN_COMPLETED_JOBS = 3;
export const TOP_CREATOR_MIN_AVERAGE = 4.5;

export const RESPONDS_FAST_WINDOW_HOURS = 24;
export const RESPONDS_FAST_MIN_REQUESTS = 3;
export const RESPONDS_FAST_MIN_SHARE = 0.8;

export type CreatorBadge = "top_creator" | "responds_fast";

export type ReviewScores = {
  communication: number;
  timeliness: number;
  satisfaction: number;
};

export type CreatorReviewRow = ReviewScores & {
  id: string;
  order_id: string;
  business_name: string;
  body: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewAggregates = {
  review_count: number;
  avg_communication: number | null;
  avg_timeliness: number | null;
  avg_satisfaction: number | null;
  avg_overall: number | null;
};

export type RespondsFastStats = {
  computable: boolean;
  requests_counted: number;
  answered_within_window: number;
  share_within_window: number | null;
};

export type CreatorReputation = {
  aggregates: ReviewAggregates;
  completed_job_count: number;
  responds_fast: RespondsFastStats;
  badges: CreatorBadge[];
  display_state: "new_to_zavi" | "rated";
  reviews: CreatorReviewRow[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateReviews(rows: ReviewScores[]): ReviewAggregates {
  if (rows.length === 0) {
    return {
      review_count: 0,
      avg_communication: null,
      avg_timeliness: null,
      avg_satisfaction: null,
      avg_overall: null,
    };
  }
  const comm = mean(rows.map((r) => r.communication));
  const time = mean(rows.map((r) => r.timeliness));
  const sat = mean(rows.map((r) => r.satisfaction));
  return {
    review_count: rows.length,
    avg_communication: round2(comm),
    avg_timeliness: round2(time),
    avg_satisfaction: round2(sat),
    avg_overall: round2(mean([comm, time, sat])),
  };
}

export function exactOverallAverage(rows: ReviewScores[]): number | null {
  if (rows.length === 0) return null;
  return mean([
    mean(rows.map((r) => r.communication)),
    mean(rows.map((r) => r.timeliness)),
    mean(rows.map((r) => r.satisfaction)),
  ]);
}

export function hasTopCreatorBadge(input: {
  completed_job_count: number;
  exact_overall_average: number | null;
}): boolean {
  if (input.exact_overall_average === null) return false;
  return (
    input.completed_job_count >= TOP_CREATOR_MIN_COMPLETED_JOBS &&
    input.exact_overall_average >= TOP_CREATOR_MIN_AVERAGE
  );
}

export function hasRespondsFastBadge(stats: RespondsFastStats): boolean {
  if (!stats.computable) return false;
  if (stats.requests_counted < RESPONDS_FAST_MIN_REQUESTS) return false;
  if (stats.share_within_window === null) return false;
  return stats.share_within_window >= RESPONDS_FAST_MIN_SHARE;
}

export function deriveBadges(input: {
  completed_job_count: number;
  exact_overall_average: number | null;
  responds_fast: RespondsFastStats;
}): CreatorBadge[] {
  const badges: CreatorBadge[] = [];
  if (hasTopCreatorBadge(input)) badges.push("top_creator");
  if (hasRespondsFastBadge(input.responds_fast)) badges.push("responds_fast");
  return badges;
}

export function displayState(aggregates: ReviewAggregates): "new_to_zavi" | "rated" {
  return aggregates.review_count === 0 ? "new_to_zavi" : "rated";
}

export function editWindowEndsAt(createdAtIso: string): Date {
  return new Date(
    new Date(createdAtIso).getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function isWithinEditWindow(createdAtIso: string, now: Date): boolean {
  return now.getTime() <= editWindowEndsAt(createdAtIso).getTime();
}

export type RespondsFastOrderRow = {
  created_at: string;
  responded_at: string | null;
  status: string;
  closed_reason: string | null;
};

export function computeRespondsFastStats(orders: RespondsFastOrderRow[]): RespondsFastStats {
  let counted = 0;
  let fast = 0;
  const windowMs = RESPONDS_FAST_WINDOW_HOURS * 60 * 60 * 1000;

  for (const o of orders) {
    if (o.responded_at) {
      counted += 1;
      const elapsed = new Date(o.responded_at).getTime() - new Date(o.created_at).getTime();
      if (elapsed <= windowMs) fast += 1;
      continue;
    }
    if (o.status === "cancelled" && o.closed_reason === "expired") {
      counted += 1;
    }
  }

  return {
    computable: counted > 0,
    requests_counted: counted,
    answered_within_window: fast,
    share_within_window: counted === 0 ? null : fast / counted,
  };
}

type ReviewDbRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  communication: number;
  timeliness: number;
  satisfaction: number;
  body: string | null;
  created_at: string;
  updated_at: string;
};

export async function loadCreatorReputation(humanMemberId: string): Promise<CreatorReputation> {
  const sb = staffCrossTenantClient(
    "a creator's public reputation is the sum of every tenant that hired them; the storefront shows it",
  );

  const { data: reviewRows, error: reviewError } = await sb
    .from("creator_reviews")
    .select("id, tenant_id, order_id, communication, timeliness, satisfaction, body, created_at, updated_at")
    .eq("human_member_id", humanMemberId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (reviewError) throw new Error(`creator_reviews read failed: ${reviewError.message}`);
  const reviews = (reviewRows ?? []) as ReviewDbRow[];

  const { data: orderRows, error: orderError } = await sb
    .from("creator_orders")
    .select("status, closed_reason, created_at, responded_at")
    .eq("human_member_id", humanMemberId)
    .limit(1000);
  if (orderError) throw new Error(`creator_orders read failed: ${orderError.message}`);
  const orders = (orderRows ?? []) as RespondsFastOrderRow[];

  const businessNames = await loadBusinessNames(
    sb,
    Array.from(new Set(reviews.map((r) => r.tenant_id))),
  );

  const aggregates = aggregateReviews(reviews);
  const completed = orders.filter((o) => o.status === "completed").length;
  const respondsFast = computeRespondsFastStats(orders);

  return {
    aggregates,
    completed_job_count: completed,
    responds_fast: respondsFast,
    badges: deriveBadges({
      completed_job_count: completed,
      exact_overall_average: exactOverallAverage(reviews),
      responds_fast: respondsFast,
    }),
    display_state: displayState(aggregates),
    reviews: reviews.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      business_name: businessNames.get(r.tenant_id) ?? "A Zavi business",
      communication: r.communication,
      timeliness: r.timeliness,
      satisfaction: r.satisfaction,
      body: r.body,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  };
}

async function loadBusinessNames(
  sb: { from: (t: string) => any },
  tenantIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (tenantIds.length === 0) return names;
  const { data } = await sb.from("tenants").select("id, display_name").in("id", tenantIds);
  for (const row of (data ?? []) as Array<{ id: string; display_name: string | null }>) {
    if (row.display_name) names.set(row.id, row.display_name);
  }
  return names;
}

async function findReviewRow(tenantId: string, orderId: string): Promise<ReviewDbRow | null> {
  const { data } = await tenantClient(asTenantId(tenantId))
    .from("creator_reviews")
    .select("id, order_id, communication, timeliness, satisfaction, body, created_at, updated_at")
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as ReviewDbRow | null) ?? null;
}

export async function getReviewForOrder(
  tenantId: string,
  orderId: string,
  now: Date = new Date(),
): Promise<
  | null
  | (ReviewScores & {
      id: string;
      order_id: string;
      body: string | null;
      created_at: string;
      updated_at: string;
      editable: boolean;
      edit_window_ends_at: string;
    })
> {
  const row = await findReviewRow(tenantId, orderId);
  if (!row) return null;
  return {
    id: row.id,
    order_id: row.order_id,
    communication: row.communication,
    timeliness: row.timeliness,
    satisfaction: row.satisfaction,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
    editable: isWithinEditWindow(row.created_at, now),
    edit_window_ends_at: editWindowEndsAt(row.created_at).toISOString(),
  };
}

export type ReviewWriteFailure =
  | "order_not_found"
  | "order_not_completed"
  | "review_already_exists"
  | "review_not_found"
  | "review_frozen"
  | "creator_cannot_review";

export type ReviewWriteResult =
  | { ok: true; review_id: string }
  | { ok: false; code: ReviewWriteFailure };

export type ReviewInput = ReviewScores & { body?: string | null };

export async function submitCreatorReview(params: {
  tenantId: string;
  actorUserId: string;
  orderId: string;
  input: ReviewInput;
}): Promise<ReviewWriteResult> {
  const tc = tenantClient(asTenantId(params.tenantId));

  const { data: orderRow } = await tc
    .from("creator_orders")
    .select("id, human_member_id, status")
    .eq("id", params.orderId)
    .maybeSingle();
  if (!orderRow) return { ok: false, code: "order_not_found" };
  const order = orderRow as { id: string; human_member_id: string; status: string };
  if (order.status !== "completed") return { ok: false, code: "order_not_completed" };

  const actingMember = await loadHumanMemberByAuthUser(params.actorUserId);
  if (actingMember && actingMember.id === order.human_member_id) {
    return { ok: false, code: "creator_cannot_review" };
  }

  const existing = await findReviewRow(params.tenantId, params.orderId);
  if (existing) return { ok: false, code: "review_already_exists" };

  const { data, error } = await tc
    .from("creator_reviews")
    .insert({
      order_id: params.orderId,
      human_member_id: order.human_member_id,
      communication: params.input.communication,
      timeliness: params.input.timeliness,
      satisfaction: params.input.satisfaction,
      body: normaliseBody(params.input.body),
      reviewer_user_id: params.actorUserId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { ok: false, code: "review_already_exists" };
    throw new Error(`creator_reviews insert failed: ${error.message}`);
  }
  return { ok: true, review_id: (data as { id: string } | null)?.id ?? "" };
}

export async function updateCreatorReview(params: {
  tenantId: string;
  orderId: string;
  input: ReviewInput;
  now?: Date;
}): Promise<ReviewWriteResult> {
  const now = params.now ?? new Date();
  const existing = await getReviewForOrder(params.tenantId, params.orderId, now);
  if (!existing) return { ok: false, code: "review_not_found" };
  if (!existing.editable) return { ok: false, code: "review_frozen" };

  const tc = tenantClient(asTenantId(params.tenantId));
  const { error } = await tc
    .from("creator_reviews")
    .update({
      communication: params.input.communication,
      timeliness: params.input.timeliness,
      satisfaction: params.input.satisfaction,
      body: normaliseBody(params.input.body),
      updated_at: now.toISOString(),
    })
    .eq("order_id", params.orderId);
  if (error) throw new Error(`creator_reviews update failed: ${error.message}`);
  return { ok: true, review_id: existing.id };
}

function normaliseBody(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed;
}
