
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { unreserveBatchFanoutBudget } from "@/services/agents/batch-fanout-reservation";
import { recordChildTerminalAndCheckBatch } from "@/services/agents/batch-fanout-rollup";
import { alert as fanOutAlert } from "@/services/logging/alert";
import { buildRunRequestedEventForRunId } from "../../src/services/agents/run-lane";

const TERMINAL_BATCH_STATUSES = ["failed", "done"];
const STUCK_BATCH_STATUSES = ["running", "approved"];
const CHILD_TERMINAL_STATUSES = new Set([
  "done",
  "success",
  "failed",
  "parse_failed",
  "cancelled",
  "dispatch_error",
]);
const TERMINAL_AGE_MS = 60 * 60 * 1000;
const STUCK_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_PER_TICK = 50;

type ReservationRow = {
  batch_id: string;
  tenant_id: string;
  total_reserved: number;
  reserved_at: string;
  acknowledged_at: string | null;
};

async function alert(msg: string): Promise<void> {
  await fanOutAlert({ source: "batch-fanout-refund-reconciler", msg });
}

async function sumChildSpend(
  sb: ReturnType<typeof serviceClient>,
  batch_id: string,
  tenant_id: string,
): Promise<{
  actualSpend: number;
  allTerminal: boolean;
  childCount: number;
  readOk: boolean;
}> {
  const { data: kids, error } = await sb
    .from("agent_runs")
    .select("status, cost_usd")
    .eq("batch_id", batch_id)
    .eq("tenant_id", tenant_id);
  if (error || !kids) {
    return { actualSpend: 0, allTerminal: false, childCount: 0, readOk: false };
  }
  const actualSpend = kids.reduce(
    (s, r) => s + (typeof r.cost_usd === "number" ? r.cost_usd : 0),
    0,
  );
  const allTerminal =
    kids.length > 0 &&
    kids.every((r) => CHILD_TERMINAL_STATUSES.has((r.status as string) ?? ""));
  return { actualSpend, allTerminal, childCount: kids.length, readOk: true };
}

export const batchFanoutRefundReconcilerFn = inngest.createFunction(
  {
    id: "batch-fanout-refund-reconciler",
    concurrency: { limit: 1, key: '"global"' },
  },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const nowMs = Date.now();

    const { data: reservations, error } = await sb
      .from("batch_fanout_reservations")
      .select("batch_id, tenant_id, total_reserved, reserved_at, acknowledged_at")
      .is("acknowledged_at", null)
      .limit(MAX_PER_TICK + 1);
    if (error) {
      await alert(`reconciler reservation scan failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
    const rows = (reservations ?? []) as ReservationRow[];
    if (rows.length === 0) {
      return { ok: true, scanned: 0, refunded_a: 0, refunded_b: 0 };
    }
    if (rows.length > MAX_PER_TICK) {
      await alert(
        `reconciler backlog: ${rows.length} un-acked reservations (cap ${MAX_PER_TICK}); processing first ${MAX_PER_TICK}`,
      );
    }

    const batchIds = rows.slice(0, MAX_PER_TICK).map((r) => r.batch_id);
    const { data: batches } = await sb
      .from("agent_run_batches")
      .select("id, status")
      .in("id", batchIds);
    const statusById = new Map<string, string>(
      (batches ?? []).map((b) => [b.id as string, b.status as string]),
    );
    const { data: refunded } = await sb
      .from("batch_fanout_refunds")
      .select("batch_id")
      .in("batch_id", batchIds);
    const alreadyRefunded = new Set(
      (refunded ?? []).map((r) => r.batch_id as string),
    );

    let refundedA = 0;
    let refundedB = 0;
    let refundedUsd = 0;

    for (const r of rows.slice(0, MAX_PER_TICK)) {
      if (alreadyRefunded.has(r.batch_id)) continue;
      const status = statusById.get(r.batch_id) ?? "";
      const ageMs = nowMs - new Date(r.reserved_at).getTime();

      if (TERMINAL_BATCH_STATUSES.includes(status) && ageMs > TERMINAL_AGE_MS) {
        const { actualSpend, readOk } = await sumChildSpend(sb, r.batch_id, r.tenant_id);
        if (!readOk) {
          await alert(`reconciler clauseA: child-spend read failed for batch ${r.batch_id}; skipping refund this tick`);
          continue;
        }
        try {
          const res = await unreserveBatchFanoutBudget({
            batch_id: r.batch_id,
            actual_spend_usd: actualSpend,
            refund_reason: "recon_clauseA",
          });
          if (res.ok && typeof res.refunded_usd === "number") {
            refundedA += 1;
            refundedUsd += res.refunded_usd;
          }
        } catch (e) {
          await alert(`reconciler clauseA refund failed for batch ${r.batch_id}: ${(e as Error).message}`);
        }
        continue;
      }

      if (STUCK_BATCH_STATUSES.includes(status) && ageMs > STUCK_AGE_MS) {
        const { data: kids, error: kidsErr } = await sb
          .from("agent_runs")
          .select("id, child_index, status")
          .eq("batch_id", r.batch_id)
          .eq("tenant_id", r.tenant_id);
        if (kidsErr || !kids) {
          await alert(`reconciler clauseB: child read failed for batch ${r.batch_id}; skipping this tick`);
          continue;
        }
        const allTerminal =
          kids.length > 0 &&
          kids.every((k) =>
            CHILD_TERMINAL_STATUSES.has((k.status as string) ?? ""),
          );
        if (!allTerminal) continue;
        const rep = kids.find((k) => typeof k.child_index === "number");
        if (!rep) {
          await alert(`reconciler clauseB: batch ${r.batch_id} all-terminal but no child carries child_index; skipping`);
          continue;
        }
        const { data: bRow } = await sb
          .from("agent_run_batches")
          .select("thread_id")
          .eq("id", r.batch_id)
          .maybeSingle();
        try {
          const rollup = await recordChildTerminalAndCheckBatch({
            run_id: rep.id as string,
            tenant_id: r.tenant_id,
            batch_id: r.batch_id,
            child_index: rep.child_index as number,
            status: (rep.status as string) ?? "failed",
            reason: "recon_clauseB",
          });
          if (rollup.batch_complete) {
            refundedB += 1;
            const threadId = (bRow?.thread_id as string | null) ?? null;
            if (threadId) {
              const { data: promotedId, error: pErr } = await sb.rpc(
                "promote_next_blocked_run",
                { p_tenant_id: r.tenant_id, p_thread_id: threadId },
              );
              if (pErr) {
                await alert(`reconciler clauseB: promote_next failed (batch ${r.batch_id}, thread ${threadId}): ${pErr.message}`);
              } else if (promotedId) {
                await inngest.send(
                  await buildRunRequestedEventForRunId(sb, promotedId as string, {
                    tenant_id: r.tenant_id,
                  }),
                );
              }
            }
          }
        } catch (e) {
          await alert(`reconciler clauseB flip/refund failed for batch ${r.batch_id}: ${(e as Error).message}`);
        }
      }
    }

    if (refundedA + refundedB > 0) {
      await alert(
        `reconciler refunded ${refundedA + refundedB} batch reservation(s) ` +
          `[clauseA=${refundedA} clauseB=${refundedB}] totaling $${refundedUsd.toFixed(4)}`,
      );
    }

    logger.info(
      `batch-fanout-refund-reconciler: scanned=${rows.length} refunded_a=${refundedA} refunded_b=${refundedB} usd=${refundedUsd.toFixed(4)}`,
    );
    return {
      ok: true,
      scanned: rows.length,
      refunded_a: refundedA,
      refunded_b: refundedB,
      refunded_usd: refundedUsd,
    };
  },
);
