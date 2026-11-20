
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export const MAX_DELEGATION_DEPTH = 8;

export const LINEAGE_COST_CEILING_USD = 25;

export const LINEAGE_ID_KEY = "_delegation_lineage_id";
export const LINEAGE_DEPTH_KEY = "_delegation_depth";

export type DelegationDecisionInput = {
  parentDepth: number;
  targetSlug: string;
  lineageSlugs: readonly string[];
  cumulativeCost: number;
};

export type DelegationDecision =
  | { allow: true; childDepth: number }
  | {
      allow: false;
      reason: "depth_exceeded" | "cycle_detected" | "cost_ceiling_exceeded";
      escalate: boolean;
      message: string;
      detail: {
        childDepth: number;
        maxDepth: number;
        targetSlug: string;
        cumulativeCost: number;
        ceiling: number;
      };
    };

export function decideDelegation(
  input: DelegationDecisionInput,
): DelegationDecision {
  const { targetSlug, lineageSlugs } = input;

  const parentDepth = input.parentDepth;
  const cumulativeCost = input.cumulativeCost;
  const childDepth = parentDepth + 1;

  const depthUnsafe =
    !Number.isFinite(parentDepth) || parentDepth < 0 || !Number.isFinite(childDepth);
  if (depthUnsafe || childDepth > MAX_DELEGATION_DEPTH) {
    return {
      allow: false,
      reason: "depth_exceeded",
      escalate: false,
      message:
        `Delegation refused: this request has already chained ${Math.max(0, Math.floor(parentDepth) || 0)} ` +
        `level(s) deep and another hop would exceed the safety limit of ${MAX_DELEGATION_DEPTH}. ` +
        `Stop delegating and answer with what the team has gathered, or escalate to a human.`,
      detail: {
        childDepth,
        maxDepth: MAX_DELEGATION_DEPTH,
        targetSlug,
        cumulativeCost,
        ceiling: LINEAGE_COST_CEILING_USD,
      },
    };
  }

  if (lineageSlugs.includes(targetSlug)) {
    return {
      allow: false,
      reason: "cycle_detected",
      escalate: false,
      message:
        `Delegation refused: "${targetSlug}" already appears earlier in this request's ` +
        `delegation chain — re-delegating to it would form a cycle. Synthesize what's ` +
        `already been gathered instead of looping back.`,
      detail: {
        childDepth,
        maxDepth: MAX_DELEGATION_DEPTH,
        targetSlug,
        cumulativeCost,
        ceiling: LINEAGE_COST_CEILING_USD,
      },
    };
  }

  const costUnsafe = !Number.isFinite(cumulativeCost) || cumulativeCost < 0;
  if (costUnsafe || cumulativeCost >= LINEAGE_COST_CEILING_USD) {
    return {
      allow: false,
      reason: "cost_ceiling_exceeded",
      escalate: true,
      message:
        `Delegation halted: this request's delegation tree has already spent ` +
        `$${costUnsafe ? "?" : cumulativeCost.toFixed(2)} (ceiling $${LINEAGE_COST_CEILING_USD}). ` +
        `Escalating to a human rather than spending more — review the run tree before continuing.`,
      detail: {
        childDepth,
        maxDepth: MAX_DELEGATION_DEPTH,
        targetSlug,
        cumulativeCost,
        ceiling: LINEAGE_COST_CEILING_USD,
      },
    };
  }

  return { allow: true, childDepth };
}

export type LineageContext = {
  lineage_id: string | null;
  depth: number;
};

export function readLineageContext(
  payload: Record<string, unknown> | null | undefined,
): LineageContext {
  if (!payload || typeof payload !== "object") {
    return { lineage_id: null, depth: 0 };
  }
  const rawId = payload[LINEAGE_ID_KEY];
  const rawDepth = payload[LINEAGE_DEPTH_KEY];
  const lineage_id = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
  const depth =
    typeof rawDepth === "number" && Number.isFinite(rawDepth) && rawDepth >= 0
      ? Math.floor(rawDepth)
      : 0;
  return { lineage_id, depth };
}

export function buildChildLineagePayload<T extends Record<string, unknown>>(
  basePayload: T,
  args: { lineage_id: string; childDepth: number },
): T & Record<string, unknown> {
  return {
    ...basePayload,
    [LINEAGE_ID_KEY]: args.lineage_id,
    [LINEAGE_DEPTH_KEY]: args.childDepth,
  };
}

export type DelegationGuardInput = {
  tenant_id: string;
  parentLineage: LineageContext;
  source_agent_slug: string;
  target_agent_slug: string;
};

export type DelegationGuardResult =
  | {
      ok: true;
      lineage_id: string;
      childDepth: number;
    }
  | {
      ok: false;
      reason:
        | "depth_exceeded"
        | "cycle_detected"
        | "cost_ceiling_exceeded"
        | "lookup_failed";
      escalate: boolean;
      message: string;
    };

export async function checkDelegationAllowed(
  input: DelegationGuardInput,
  mintLineageId: () => string = () => crypto.randomUUID(),
): Promise<DelegationGuardResult> {
  const parentDepth = input.parentLineage.depth;

  let lineage_id = input.parentLineage.lineage_id;
  let lineageSlugs: readonly string[] = [];
  let cumulativeCost = 0;

  if (lineage_id !== null) {
    const stats = await readLineageStats(input.tenant_id, lineage_id);
    if (!stats.ok) {
      await logGuard({
        tenant_id: input.tenant_id,
        code: "delegation_guard.lookup_failed",
        target_agent_slug: input.target_agent_slug,
        message: `lineage_tree_stats lookup failed for lineage ${lineage_id}: ${stats.error}`,
      });
      return {
        ok: false,
        reason: "lookup_failed",
        escalate: true,
        message:
          "Delegation refused: couldn't verify this request's delegation tree (depth/cost) — " +
          "failing closed for safety. Retry, or escalate to a human if it persists.",
      };
    }
    lineageSlugs = stats.target_slugs;
    cumulativeCost = stats.cumulative_cost;
  }

  const decision = decideDelegation({
    parentDepth,
    targetSlug: input.target_agent_slug,
    lineageSlugs,
    cumulativeCost,
  });

  if (!decision.allow) {
    await logGuard({
      tenant_id: input.tenant_id,
      code: `delegation_guard.${decision.reason}`,
      target_agent_slug: input.target_agent_slug,
      message: decision.message,
    });
    return {
      ok: false,
      reason: decision.reason,
      escalate: decision.escalate,
      message: decision.message,
    };
  }

  if (lineage_id === null) {
    lineage_id = mintLineageId();
  }

  return { ok: true, lineage_id, childDepth: decision.childDepth };
}

export async function checkFanoutDelegationsAllowed(
  base: Omit<DelegationGuardInput, "target_agent_slug">,
  targetSlugs: readonly string[],
  mintLineageId: () => string = () => crypto.randomUUID(),
): Promise<DelegationGuardResult> {
  if (targetSlugs.length === 0) {
    return {
      ok: false,
      reason: "lookup_failed",
      escalate: false,
      message: "Delegation refused: no targets supplied to the fan-out guard.",
    };
  }

  const parentDepth = base.parentLineage.depth;
  let lineageSlugs: readonly string[] = [];
  let cumulativeCost = 0;

  if (base.parentLineage.lineage_id !== null) {
    const stats = await readLineageStats(base.tenant_id, base.parentLineage.lineage_id);
    if (!stats.ok) {
      await logGuard({
        tenant_id: base.tenant_id,
        code: "delegation_guard.lookup_failed",
        target_agent_slug: targetSlugs[0],
        message: `lineage_tree_stats lookup failed for lineage ${base.parentLineage.lineage_id}: ${stats.error}`,
      });
      return {
        ok: false,
        reason: "lookup_failed",
        escalate: true,
        message:
          "Delegation refused: couldn't verify this request's delegation tree (depth/cost) — " +
          "failing closed for safety. Retry, or escalate to a human if it persists.",
      };
    }
    lineageSlugs = stats.target_slugs;
    cumulativeCost = stats.cumulative_cost;
  }

  let childDepth = parentDepth + 1;
  for (const targetSlug of targetSlugs) {
    const decision = decideDelegation({ parentDepth, targetSlug, lineageSlugs, cumulativeCost });
    if (!decision.allow) {
      await logGuard({
        tenant_id: base.tenant_id,
        code: `delegation_guard.${decision.reason}`,
        target_agent_slug: targetSlug,
        message: decision.message,
      });
      return {
        ok: false,
        reason: decision.reason,
        escalate: decision.escalate,
        message: decision.message,
      };
    }
    childDepth = decision.childDepth;
  }

  const lineage_id =
    base.parentLineage.lineage_id !== null ? base.parentLineage.lineage_id : mintLineageId();
  return { ok: true, lineage_id, childDepth };
}

type LineageStats =
  | { ok: true; max_depth: number; target_slugs: string[]; cumulative_cost: number }
  | { ok: false; error: string };

async function readLineageStats(
  tenant_id: string,
  lineage_id: string,
): Promise<LineageStats> {
  try {
    const { data, error } = await serviceClient().rpc("lineage_tree_stats", {
      p_tenant_id: tenant_id,
      p_lineage_id: lineage_id,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { ok: false, error: "lineage_tree_stats returned no row" };
    }
    const max_depth = Number(row.max_depth ?? 0);
    const cumulative_cost = Number(row.cumulative_cost ?? 0);
    const target_slugs = Array.isArray(row.target_slugs)
      ? (row.target_slugs.filter((s: unknown) => typeof s === "string") as string[])
      : [];
    if (!Number.isFinite(max_depth) || !Number.isFinite(cumulative_cost)) {
      return { ok: false, error: "lineage_tree_stats returned non-finite numbers" };
    }
    return { ok: true, max_depth, target_slugs, cumulative_cost };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function recordDelegation(input: {
  tenant_id: string;
  lineage_id: string;
  depth: number;
  parent_run_id: string | null;
  child_run_id: string | null;
  source_agent_slug: string;
  target_agent_slug: string;
}): Promise<boolean> {
  try {
    const { error } = await serviceClient().from("delegation_lineage").insert({
      tenant_id: input.tenant_id,
      lineage_id: input.lineage_id,
      depth: input.depth,
      parent_run_id: input.parent_run_id,
      child_run_id: input.child_run_id,
      source_agent_slug: input.source_agent_slug,
      target_agent_slug: input.target_agent_slug,
    });
    if (error) {
      await logGuard({
        level: "error",
        tenant_id: input.tenant_id,
        code: "delegation.lineage_write_failed",
        target_agent_slug: input.target_agent_slug,
        message: `delegation_lineage insert failed (lineage ${input.lineage_id}, depth ${input.depth}): ${error.message}`,
      });
      return false;
    }
    return true;
  } catch (e) {
    await logGuard({
      level: "error",
      tenant_id: input.tenant_id,
      code: "delegation.lineage_write_failed",
      target_agent_slug: input.target_agent_slug,
      message: `delegation_lineage insert threw (lineage ${input.lineage_id}): ${(e as Error).message}`,
    });
    return false;
  }
}

async function logGuard(args: {
  level?: "warn" | "error";
  tenant_id: string;
  code: string;
  target_agent_slug: string;
  message: string;
}): Promise<void> {
  await logEvent({
    level: args.level ?? "warn",
    source: "delegation_guard",
    code: args.code,
    tenant_id: args.tenant_id,
    message: args.message,
    meta: { agent_slug: args.target_agent_slug },
  });
}
