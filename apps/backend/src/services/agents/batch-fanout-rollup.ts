
import { serviceClient } from "@/services/supabase";
import { unreserveBatchFanoutBudget } from "@/services/agents/batch-fanout-reservation";
import { alert } from "@/services/logging/alert";
import { scrubAgentEgress } from "./scrub-agent-egress";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";

const TERMINAL_STATUSES = new Set([
  "done",
  "success",
  "failed",
  "parse_failed",
  "cancelled",
  "dispatch_error",
]);
const SUCCESS_STATUSES = new Set(["done", "success"]);
const LIVE_STATUSES = new Set(["queued", "running", "blocked"]);

export type ChildTerminalInput = {
  run_id: string;
  tenant_id: string;
  batch_id: string;
  child_index: number;
  status: string;
  pr_url?: string | null;
  reason?: string | null;
};

export type ChildTerminalResult = {
  batch_complete: boolean;
  final_batch_status?: "done" | "failed";
};

export async function recordChildTerminalAndCheckBatch(
  input: ChildTerminalInput,
): Promise<ChildTerminalResult> {
  const sb = serviceClient();

  const [{ data: batchRow, error: batchErr }, { data: siblings, error: sibErr }] =
    await Promise.all([
      sb
        .from("agent_run_batches")
        .select("id, status, task_specs, rollup, thread_id, tenant_id")
        .eq("id", input.batch_id)
        .eq("tenant_id", input.tenant_id)
        .maybeSingle(),
      sb
        .from("agent_runs")
        .select("id, child_index, status, cost_usd")
        .eq("batch_id", input.batch_id)
        .eq("tenant_id", input.tenant_id),
    ]);
  if (batchErr || !batchRow) {
    throw new Error(
      `recordChildTerminal: batch ${input.batch_id} read failed: ${batchErr?.message ?? "not found"}`,
    );
  }
  if (sibErr || !siblings) {
    throw new Error(
      `recordChildTerminal: siblings read failed: ${sibErr?.message ?? "no rows"}`,
    );
  }

  const priorRollup =
    (batchRow.rollup as Record<string, unknown> | null) ?? {};
  const slotKey = String(input.child_index);
  const slotValue = {
    run_id: input.run_id,
    status: input.status,
    finished_at: new Date().toISOString(),
    ...(input.pr_url ? { pr_url: input.pr_url } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  const nextRollup = { ...priorRollup, [slotKey]: slotValue };

  await sb
    .from("agent_run_batches")
    .update({ rollup: nextRollup, updated_at: new Date().toISOString() })
    .eq("id", input.batch_id)
    .eq("tenant_id", input.tenant_id);

  const taskCount = Array.isArray(batchRow.task_specs)
    ? (batchRow.task_specs as unknown[]).length
    : 0;
  let allTerminal = siblings.length === taskCount && taskCount > 0;
  let anyFailed = false;
  for (const s of siblings) {
    const st = (s.status as string) ?? "";
    if (LIVE_STATUSES.has(st)) {
      allTerminal = false;
    }
    if (TERMINAL_STATUSES.has(st) && !SUCCESS_STATUSES.has(st)) {
      anyFailed = true;
    }
  }

  if (!allTerminal) {
    return { batch_complete: false };
  }

  const finalStatus: "done" | "failed" = anyFailed ? "failed" : "done";
  const { data: flipped } = await sb
    .from("agent_run_batches")
    .update({
      status: finalStatus,
      rollup: nextRollup,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.batch_id)
    .eq("tenant_id", input.tenant_id)
    .in("status", ["running", "approved"])
    .select("id, thread_id");

  if (!flipped || flipped.length === 0) {
    return { batch_complete: false };
  }

  const actualSpend = siblings.reduce(
    (sum, s) => sum + (typeof s.cost_usd === "number" ? s.cost_usd : 0),
    0,
  );
  try {
    await unreserveBatchFanoutBudget({
      batch_id: input.batch_id,
      actual_spend_usd: actualSpend,
      refund_reason:
        finalStatus === "failed"
          ? "rollup_failed"
          : "rollup_done_underspent",
    });
  } catch (e) {
    await alert({
      source: "batch-fanout-rollup",
      msg: `rollup refund failed for batch=${input.batch_id} (reconciler will retry): ${(e as Error).message}`,
    });
  }

  const threadId = (flipped[0].thread_id as string | null) ?? null;
  if (threadId) {
    const lines: string[] = [];
    const taskSpecs = (batchRow.task_specs as Array<{ title?: string }>) ?? [];
    for (let i = 0; i < taskCount; i++) {
      const slot = nextRollup[String(i)] as
        | { status?: string; pr_url?: string; reason?: string }
        | undefined;
      const title = taskSpecs[i]?.title ?? `Task ${i + 1}`;
      if (!slot) {
        lines.push(`${i + 1}. **${title}** — _no result came back_`);
        continue;
      }
      const slotSucceeded = slot.status === "done" || slot.status === "success";
      if (slotSucceeded && slot.pr_url) {
        lines.push(`${i + 1}. **${title}** — opened ${slot.pr_url}`);
      } else if (slotSucceeded) {
        lines.push(`${i + 1}. **${title}** — done (no PR opened)`);
      } else {
        const reason = slot.reason ? ` — ${slot.reason}` : "";
        lines.push(`${i + 1}. **${title}** — _${slot.status}_${reason}`);
      }
    }
    const header =
      finalStatus === "done"
        ? `_Done — ${taskCount} task${taskCount === 1 ? "" : "s"} finished._`
        : `_These finished with failures — see each task below._`;
    const body = scrubAgentEgress(`${header}\n\n${lines.join("\n")}`, {
      surface: "batch",
    }).text;
    try {
      await sb.from("agent_thread_messages").insert({
        thread_id: threadId,
        tenant_id: input.tenant_id,
        sender_role: "assistant",
        body,
        meta: {
          batch_id: input.batch_id,
          batch_final_status: finalStatus,
          batch_rollup: nextRollup,
        },
        agent_run_id: null,
      });
      await sb
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", threadId);
      void notifyThreadOwner({
        tenant_id: input.tenant_id,
        thread_id: threadId,
        agent_slug: "operator",
        body: "Zavi posted a new message.",
      }).catch(() => {});
    } catch (e) {
      console.warn(
        `[batch-fanout-rollup] summary write failed for batch=${input.batch_id}: ${(e as Error).message}`,
      );
    }
  }

  return { batch_complete: true, final_batch_status: finalStatus };
}
