
import { logEvent } from "@/services/logging/logEvent";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import {
  MAX_REVIEW_ATTEMPTS,
  RESOLVE_STALE_MS,
  REVIEW_FAILED_ADVISORY_CLASS,
} from "./constants";
import {
  listStuckReviews,
  listFailedNeedingHeal,
  bumpAttemptForRetry,
  resetResolvingForRetry,
  recoverApproved,
  supersedeFailureNotice,
  finalizeFailed,
  findFinalCreateFor,
  getParkedDecision,
  type StuckReviewDbRow,
} from "./review-state";
import { classifyStuckReview, type ReviewRunState } from "./dead-letter";
import { enqueueStrategistReview } from "./enqueue-review";

const RUN_TERMINAL = new Set(["success", "failed", "parse_failed", "dispatch_error", "cancelled"]);

const SWEEP_GRACE_MS = 3 * 60 * 1000;

const FAILED_HEAL_WINDOW_MS = 2 * 60 * 60 * 1000;

async function resolveRunState(review_run_id: string | null, tenant_id: string): Promise<ReviewRunState> {
  if (!review_run_id) return "absent";
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("status")
    .eq("id", review_run_id)
    .maybeSingle();
  if (error || !data) return "absent";
  const status = (data as { status?: string }).status ?? "";
  return RUN_TERMINAL.has(status) ? "terminal" : "in_flight";
}

async function emitReviewFailedNotice(
  tenant_id: string,
  pending_decision_id: string,
): Promise<boolean> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "emit_decision", {
    p_agent_run_id: null,
    p_decision_class: REVIEW_FAILED_ADVISORY_CLASS,
    p_body: {
      kind: "strategist_review_failed",
      pending_decision_id,
      message:
        "A market-fit review of a proposed new ad set could not be completed. The ad set was NOT created and has not been surfaced for approval. Re-ask the performance-marketer to propose it again if you still want it.",
    },
  });
  if (error) {
    await logEvent({
      level: "warn",
      source: "strategist-review-sweep",
      code: "review_failed_notice_emit_error",
      tenant_id,
      meta: { pending_decision_id, error: error.message },
    }).catch(() => {});
    return false;
  }
  return true;
}

export type SweepResult = {
  scanned: number;
  retried: number;
  recovered: number;
  failed: number;
  waited: number;
  errors: number;
};

async function deadLetter(
  tenant_id: string,
  pending_decision_id: string,
  now: number,
): Promise<"recovered" | "failed" | "deferred" | "noop"> {
  const existing = await findFinalCreateFor(pending_decision_id, tenant_id);
  if (existing) {
    await recoverApproved(pending_decision_id, tenant_id, existing.id);
    return "recovered";
  }
  const noticed = await emitReviewFailedNotice(tenant_id, pending_decision_id);
  if (!noticed) return "deferred";
  const staleCutoffIso = new Date(now - RESOLVE_STALE_MS).toISOString();
  const won = await finalizeFailed(
    pending_decision_id,
    tenant_id,
    `strategist review exhausted ${MAX_REVIEW_ATTEMPTS} attempts`,
    staleCutoffIso,
  );
  if (!won) return "noop";
  await logEvent({
    level: "warn",
    source: "strategist-review-sweep",
    code: "review_dead_lettered",
    tenant_id,
    meta: { pending_decision_id },
  });
  return "failed";
}

async function reEnqueue(row: StuckReviewDbRow, now: number): Promise<boolean> {
  const parked = await getParkedDecision(row.pending_decision_id, row.tenant_id);
  if (!parked) {
    const staleCutoffIso = new Date(now - RESOLVE_STALE_MS).toISOString();
    await finalizeFailed(row.pending_decision_id, row.tenant_id, "parked decision missing", staleCutoffIso);
    return false;
  }
  await enqueueStrategistReview({
    pending_decision_id: row.pending_decision_id,
    tenant_id: row.tenant_id,
    pending_body: parked.body,
  });
  return true;
}

async function handleResolvingRow(
  row: StuckReviewDbRow,
  now: number,
  res: SweepResult,
): Promise<void> {
  const leaseAgeMs = now - new Date(row.claimed_at ?? row.updated_at).getTime();
  if (leaseAgeMs < RESOLVE_STALE_MS) {
    res.waited++;
    return;
  }
  const existing = await findFinalCreateFor(row.pending_decision_id, row.tenant_id);
  if (existing) {
    const recovered = await recoverApproved(row.pending_decision_id, row.tenant_id, existing.id);
    if (recovered) res.recovered++;
    return;
  }
  if (row.attempts >= MAX_REVIEW_ATTEMPTS) {
    const outcome = await deadLetter(row.tenant_id, row.pending_decision_id, now);
    if (outcome === "failed") res.failed++;
    if (outcome === "recovered") res.recovered++;
    return;
  }
  const reset = await resetResolvingForRetry({
    pending_decision_id: row.pending_decision_id,
    tenant_id: row.tenant_id,
    attempts: row.attempts,
  });
  if (!reset) return;
  if (await reEnqueue(row, now)) res.retried++;
}

async function handlePendingRow(
  row: StuckReviewDbRow,
  now: number,
  res: SweepResult,
): Promise<void> {
  const runState = await resolveRunState(row.review_run_id, row.tenant_id);
  const ageMs = now - new Date(row.updated_at).getTime();
  const action = classifyStuckReview({ row, runState, ageMs });
  if (action === "wait") {
    res.waited++;
    return;
  }
  if (action === "fail") {
    const outcome = await deadLetter(row.tenant_id, row.pending_decision_id, now);
    if (outcome === "failed") res.failed++;
    if (outcome === "recovered") res.recovered++;
    return;
  }
  const bumped = await bumpAttemptForRetry({
    pending_decision_id: row.pending_decision_id,
    tenant_id: row.tenant_id,
    attempts: row.attempts,
  });
  if (!bumped) return;
  if (await reEnqueue(row, now)) res.retried++;
}

export async function sweepStrategistReviews(now: number = Date.now()): Promise<SweepResult> {
  const graceCutoffIso = new Date(now - SWEEP_GRACE_MS).toISOString();
  const res: SweepResult = { scanned: 0, retried: 0, recovered: 0, failed: 0, waited: 0, errors: 0 };

  let rows: StuckReviewDbRow[];
  try {
    rows = await listStuckReviews(graceCutoffIso);
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "strategist-review-sweep",
      code: "list_stuck_failed",
      tenant_id: "system",
      meta: { error: (e as Error).message },
    }).catch(() => {});
    return res;
  }

  for (const row of rows) {
    res.scanned++;
    try {
      if (row.status === "resolving") {
        await handleResolvingRow(row, now, res);
      } else {
        await handlePendingRow(row, now, res);
      }
    } catch (e) {
      res.errors++;
      await logEvent({
        level: "warn",
        source: "strategist-review-sweep",
        code: "sweep_row_error",
        tenant_id: row.tenant_id,
        meta: { pending_decision_id: row.pending_decision_id, error: (e as Error).message },
      }).catch(() => {});
    }
  }

  try {
    const failedRows = await listFailedNeedingHeal(new Date(now - FAILED_HEAL_WINDOW_MS).toISOString());
    for (const row of failedRows) {
      try {
        const existing = await findFinalCreateFor(row.pending_decision_id, row.tenant_id);
        if (!existing) continue;
        const recovered = await recoverApproved(row.pending_decision_id, row.tenant_id, existing.id);
        if (recovered) {
          await supersedeFailureNotice(row.pending_decision_id, row.tenant_id);
          res.recovered++;
          await logEvent({
            level: "warn",
            source: "strategist-review-sweep",
            code: "review_failed_self_healed",
            tenant_id: row.tenant_id,
            meta: { pending_decision_id: row.pending_decision_id, final_decision_id: existing.id },
          });
        }
      } catch (e) {
        res.errors++;
        await logEvent({
          level: "warn",
          source: "strategist-review-sweep",
          code: "self_heal_row_error",
          tenant_id: row.tenant_id,
          meta: { pending_decision_id: row.pending_decision_id, error: (e as Error).message },
        }).catch(() => {});
      }
    }
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "strategist-review-sweep",
      code: "list_failed_heal_failed",
      tenant_id: "system",
      meta: { error: (e as Error).message },
    }).catch(() => {});
  }

  return res;
}
