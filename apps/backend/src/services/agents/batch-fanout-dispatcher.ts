
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { alert } from "@/services/logging/alert";
import {
  reserveBatchFanoutBudgetOrReject,
  unreserveBatchFanoutBudget,
  type ReserveBatchFanoutResult,
} from "./batch-fanout-reservation";
import type { TaskSpec, EnrichedTaskSpec } from "@/agents/engineer/decompose";
import type { AgentCostClass } from "./types";
import { computeRunLane } from "./run-lane";
import { inheritStaffModel, StaffModelCapError } from "./staff-model-inherit";
import { checkStaffModelCap } from "@/services/auth/staff-model-access";

export type DispatchBatchFanoutInput = {
  batch_id: string;
  tenant_id: string;
  thread_id: string;
  agent_slug: string;
  agent_definition_hash: string;
  cost_class: AgentCostClass;
  tasks: EnrichedTaskSpec[];
  parent_message_id: string | null;
  approval_message_id?: string | null;
  approval_user_id?: string | null;
  repo_hint?: string;
  source_run_id: string | null;
};

export type DispatchBatchFanoutSuccess = {
  ok: true;
  child_run_ids: string[];
  reserved_usd: number;
  idempotent_retry: boolean;
};

export type DispatchBatchFanoutFailure = {
  ok: false;
  reason:
    | "daily_child_cap_exceeded"
    | "daily_usd_cap_exceeded"
    | "budget_rpc_error"
    | "child_insert_failed"
    | "child_insert_count_mismatch"
    | "missing_approval_message_id"
    | "staff_model_cap";
  detail?: Record<string, unknown>;
};

export type DispatchBatchFanoutResult =
  | DispatchBatchFanoutSuccess
  | DispatchBatchFanoutFailure;

async function bestEffortUnreserve(
  batch_id: string,
  leg: string,
): Promise<void> {
  try {
    await unreserveBatchFanoutBudget({
      batch_id,
      refund_reason: `dispatcher_early_fail:${leg}`,
    });
  } catch (e) {
    await alert({
      source: "batch-fanout-dispatcher",
      msg: `dispatcher unreserve failed for ${batch_id} (${leg}); reconciler will retry: ${(e as Error).message}`,
    });
  }
}

export async function dispatchBatchFanout(
  input: DispatchBatchFanoutInput,
): Promise<DispatchBatchFanoutResult> {
  if (input.tasks.length === 0) {
    return {
      ok: false,
      reason: "child_insert_count_mismatch",
      detail: { observed: 0, expected: ">=1" },
    };
  }

  if (input.approval_message_id == null) {
    console.error(
      `[batch-fanout] REFUSING dispatch for batch ${input.batch_id}: no approval_message_id. ` +
        `Every child would die in runChat with "chat dispatcher invoked without user_message_id" ` +
        `and surface to the operator as a false failure. Callers must pass the approval message id.`,
    );
    await serviceClient()
      .from("agent_run_batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.batch_id)
      .eq("tenant_id", input.tenant_id);
    return {
      ok: false,
      reason: "missing_approval_message_id",
      detail: {
        batch_id: input.batch_id,
        why: "Batch dispatch requires approval_message_id — without it every child run dies in runChat and reports a false failure to the operator.",
      },
    };
  }

  let inheritedStaffModel: unknown;
  try {
    const inherited = await inheritStaffModel(
      { payload: {}, parent_run_id: input.source_run_id, tenant_id: input.tenant_id },
      {
        readParentPayload: async (id, tenantId) => {
          const { data, error } = await serviceClient()
            .from("agent_runs")
            .select("payload")
            .eq("id", id)
            .eq("tenant_id", tenantId)
            .maybeSingle<{ payload: unknown }>();
          if (error) throw new Error(error.message);
          return data?.payload ?? null;
        },
        checkCap: () => checkStaffModelCap(serviceClient()),
      },
    );
    inheritedStaffModel = inherited.payload?.staff_model;
  } catch (e) {
    if (!(e instanceof StaffModelCapError)) throw e;
    await serviceClient()
      .from("agent_run_batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.batch_id)
      .eq("tenant_id", input.tenant_id);
    return { ok: false, reason: "staff_model_cap", detail: { cap: e.cap } };
  }

  let reservation: ReserveBatchFanoutResult;
  try {
    reservation = await reserveBatchFanoutBudgetOrReject({
      tenant_id: input.tenant_id,
      batch_id: input.batch_id,
      parent_message_id: input.parent_message_id,
      child_count: input.tasks.length,
      cost_class: input.cost_class,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "budget_rpc_error",
      detail: { error: (e as Error).message },
    };
  }
  if (!reservation.ok) {
    const sb = serviceClient();
    await sb
      .from("agent_run_batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.batch_id)
      .eq("tenant_id", input.tenant_id);
    return {
      ok: false,
      reason: reservation.reason,
      detail: reservation.detail,
    };
  }

  const sb = serviceClient();
  if (input.approval_user_id == null) {
    console.warn(
      `[batch-fanout] dispatch for batch ${input.batch_id} has no approval_user_id — ` +
        `children will be enqueued_by=null (tenant-wide visible). Real callers must pass it.`,
    );
  }
  const childRows = input.tasks.map((task, index) => ({
    tenant_id: input.tenant_id,
    agent_slug: input.agent_slug,
    agent_definition_hash: input.agent_definition_hash,
    trigger: "chat",
    status: "queued",
    batch_id: input.batch_id,
    child_index: index,
    parent_run_id: input.source_run_id,
    enqueued_by: input.approval_user_id ?? null,
    payload: {
      thread_id: input.thread_id,
      user_message_id: input.approval_message_id,
      task_description: task.task_description,
      source_agent: "batch_fanout_child",
      batch_id: input.batch_id,
      child_index: index,
      ...((task.repo ?? input.repo_hint)
        ? { repo_hint: task.repo ?? input.repo_hint }
        : {}),
      ...(inheritedStaffModel ? { staff_model: inheritedStaffModel } : {}),
    },
  }));

  const { data: insertedRuns, error: insertErr } = await sb
    .from("agent_runs")
    .insert(childRows)
    .select("id, child_index");

  if (insertErr) {
    await sb
      .from("agent_run_batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.batch_id)
      .eq("tenant_id", input.tenant_id);
    await bestEffortUnreserve(input.batch_id, "child_insert_failed");
    return {
      ok: false,
      reason: "child_insert_failed",
      detail: { error: insertErr.message },
    };
  }

  if (!insertedRuns || insertedRuns.length !== input.tasks.length) {
    await sb
      .from("agent_run_batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.batch_id)
      .eq("tenant_id", input.tenant_id);
    await sb
      .from("agent_runs")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("batch_id", input.batch_id)
      .eq("tenant_id", input.tenant_id)
      .eq("status", "queued");
    await bestEffortUnreserve(input.batch_id, "child_insert_count_mismatch");
    return {
      ok: false,
      reason: "child_insert_count_mismatch",
      detail: {
        expected: input.tasks.length,
        observed: insertedRuns?.length ?? 0,
      },
    };
  }

  await sb
    .from("agent_run_batches")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", input.batch_id)
    .eq("tenant_id", input.tenant_id);

  const childRunIds = insertedRuns.map((r) => r.id as string);
  await Promise.allSettled(
    insertedRuns.map((r) =>
      inngest.send({
        id: `batch-fanout:${input.batch_id}:${r.child_index}`,
        name: "agent.run.requested",
        data: {
          run_id: r.id as string,
          tenant_id: input.tenant_id,
          agent_slug: input.agent_slug,
          lane: computeRunLane("chat", input.batch_id),
        },
      }),
    ),
  );

  return {
    ok: true,
    child_run_ids: childRunIds,
    reserved_usd: reservation.reserved_usd,
    idempotent_retry: reservation.idempotent_retry,
  };
}
