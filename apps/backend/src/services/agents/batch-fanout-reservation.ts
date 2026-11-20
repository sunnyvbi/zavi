
import { serviceClient } from "@/services/supabase";
import { estimateRunCost, resolveDailyCapUsd } from "@/services/agents/budget";
import type { AgentCostClass } from "@/services/agents/types";

export const MAX_CHILDREN_PER_BATCH = 4;

export function resolveDailyChildCap(): number {
  const raw = process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export type ReserveBatchFanoutInput = {
  tenant_id: string;
  batch_id: string;
  parent_message_id: string | null;
  child_count: number;
  cost_class: AgentCostClass;
  daily_child_cap?: number;
  daily_usd_cap?: number;
};

export type ReserveBatchFanoutResult =
  | {
      ok: true;
      reserved_usd: number;
      remaining_usd: number | null;
      idempotent_retry: boolean;
    }
  | {
      ok: false;
      reason:
        | "daily_child_cap_exceeded"
        | "daily_usd_cap_exceeded";
      detail: Record<string, unknown>;
    };

export async function reserveBatchFanoutBudgetOrReject(
  input: ReserveBatchFanoutInput,
): Promise<ReserveBatchFanoutResult> {
  if (input.child_count <= 0 || input.child_count > MAX_CHILDREN_PER_BATCH) {
    throw new Error(
      `reserveBatchFanoutBudgetOrReject: child_count ${input.child_count} out of range [1..${MAX_CHILDREN_PER_BATCH}]`,
    );
  }

  const estimatePerChild = estimateRunCost(input.cost_class);
  const dailyChildCap = input.daily_child_cap ?? resolveDailyChildCap();
  const dailyUsdCap =
    input.daily_usd_cap ?? (await resolveDailyCapUsd(input.tenant_id));

  const { data, error } = await serviceClient().rpc(
    "reserve_batch_fanout_budget_or_reject",
    {
      p_tenant_id: input.tenant_id,
      p_batch_id: input.batch_id,
      p_parent_message_id: input.parent_message_id,
      p_child_count: input.child_count,
      p_estimate_usd_per_child: estimatePerChild,
      p_daily_child_cap: dailyChildCap,
      p_daily_usd_cap: dailyUsdCap,
    },
  );
  if (error) {
    throw new Error(
      `reserve_batch_fanout_budget_or_reject failed: ${error.message}`,
    );
  }

  const result = data as Record<string, unknown> | null;
  if (!result || typeof result !== "object") {
    throw new Error(
      "reserve_batch_fanout_budget_or_reject returned empty/non-object",
    );
  }

  if (result.ok === true) {
    const reserved = result.reserved_usd;
    if (typeof reserved !== "number" || !Number.isFinite(reserved)) {
      throw new Error(
        `reserve_batch_fanout_budget_or_reject malformed success: reserved_usd is not a finite number (got ${typeof reserved}: ${JSON.stringify(reserved)})`,
      );
    }
    const remainingRaw = result.remaining_usd;
    let remaining: number | null;
    if (remainingRaw === null || remainingRaw === undefined) {
      remaining = null;
    } else if (typeof remainingRaw === "number" && Number.isFinite(remainingRaw)) {
      remaining = remainingRaw;
    } else {
      throw new Error(
        `reserve_batch_fanout_budget_or_reject malformed success: remaining_usd must be null or a finite number (got ${typeof remainingRaw}: ${JSON.stringify(remainingRaw)})`,
      );
    }
    return {
      ok: true,
      reserved_usd: reserved,
      remaining_usd: remaining,
      idempotent_retry: result.idempotent_retry === true,
    };
  }

  const reason = (result.reason ?? "unknown") as string;
  if (
    reason !== "daily_child_cap_exceeded" &&
    reason !== "daily_usd_cap_exceeded"
  ) {
    throw new Error(
      `reserve_batch_fanout_budget_or_reject unexpected reason: ${reason}`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ok: _ok, reason: _reason, ...detail } = result as {
    ok: boolean;
    reason: string;
  } & Record<string, unknown>;
  return {
    ok: false,
    reason,
    detail,
  };
}

export type UnreserveBatchFanoutInput = {
  batch_id: string;
  refund_usd?: number;
  actual_spend_usd?: number;
  refund_reason?: string;
};

export type UnreserveBatchFanoutResult = {
  ok: boolean;
  refunded_usd?: number;
  refunded_children?: number;
  reason?: string;
};

export async function unreserveBatchFanoutBudget(
  input: UnreserveBatchFanoutInput,
): Promise<UnreserveBatchFanoutResult> {
  const { data, error } = await serviceClient().rpc(
    "unreserve_batch_fanout_budget",
    {
      p_batch_id: input.batch_id,
      p_refund_usd: input.refund_usd ?? null,
      p_actual_spend_usd: input.actual_spend_usd ?? null,
      p_refund_reason: input.refund_reason ?? "failed_zero_actual_spend",
    },
  );
  if (error) {
    throw new Error(`unreserve_batch_fanout_budget failed: ${error.message}`);
  }
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    ok: result.ok === true,
    refunded_usd:
      typeof result.refunded_usd === "number" ? result.refunded_usd : undefined,
    refunded_children:
      typeof result.refunded_children === "number"
        ? result.refunded_children
        : undefined,
    reason: typeof result.reason === "string" ? result.reason : undefined,
  };
}
