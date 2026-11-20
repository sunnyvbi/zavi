
import { actionsStoreFor } from "@zavi/shared";
import { switchedChannelForRun } from "./channel-actions";
import { topActionProposalCap, topActionProposalProblem, topActionRefusesClass } from "./top-actions";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function topActionScopeForRun(tenant_id: string, run_id: string): Promise<{ channel_slug: unknown; top_action: unknown }> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("channel_slug, top_action:payload->top_action")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`top action read failed: ${error.message}`);
  const row = (data ?? {}) as { channel_slug?: unknown; top_action?: unknown };
  return { channel_slug: row.channel_slug ?? null, top_action: row.top_action ?? null };
}
import { ExpectedToolError } from "@/services/tools/types";
import { chatAnswerTurnEmit, isChatAnswerTurnEmit } from "@/services/agents/redo-mode";

export type EmitDecisionFn = (decision_class: string, body: unknown) => Promise<string>;

export type ExecEmitCtx = {
  tenant_id: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  chat_answer_turn?: boolean;
  top_action_run?: boolean;
  run_trigger?: string;
  trigger?: string;
  emit_decision?: EmitDecisionFn;
};

export type ExecEmitWriter = (args: {
  tenant_id: string;
  run_id: string;
  channel_slug: string;
  decision_class: string;
  body: Record<string, unknown>;
  legacyEmit: EmitDecisionFn;
}) => Promise<string>;

export async function resolveChannelExecEmit(
  channels: ReadonlySet<string>,
  ctx: ExecEmitCtx,
  write: ExecEmitWriter,
  readTopActionScope: typeof topActionScopeForRun = topActionScopeForRun,
): Promise<EmitDecisionFn | undefined> {
  if (ctx.chat_answer_turn || isChatAnswerTurnEmit(ctx.emit_decision)) return chatAnswerTurnEmit;
  if (!ctx.emit_decision || !ctx.run_id) return ctx.emit_decision;
  const switchedChannels = [...channels].filter(
    (c) => actionsStoreFor(c) === "channel_actions",
  );
  if (switchedChannels.length === 0) return ctx.emit_decision;

  let switched: string | null;
  if ((ctx.run_trigger ?? ctx.trigger) === "chat") {
    const { healChatRunStamp } = await import("./direct-run");
    let healed = await healChatRunStamp(ctx.tenant_id, ctx.run_id);
    if (healed === "unreadable") healed = await healChatRunStamp(ctx.tenant_id, ctx.run_id);
    if (healed === "failed" || healed === "unreadable") {
      return async () => {
        throw new ExpectedToolError(
          "channel_stamp_unreadable",
          "Could not record which channel this chat belongs to, so there is no way to tell where this change should be proposed. Nothing was written. Try again.",
        );
      };
    }
    switched = healed !== null && actionsStoreFor(healed) === "channel_actions" ? healed : null;
  } else {
    try {
      switched = await switchedChannelForRun(ctx.tenant_id, ctx.run_id);
    } catch (e) {
      throw new ExpectedToolError(
        "channel_stamp_unreadable",
        "Could not read which channel this run belongs to, so there is no way to tell where this change should be proposed. Nothing was written — try again.",
        { cause: (e as Error).message },
      );
    }
  }
  if (!switched || !switchedChannels.includes(switched)) return ctx.emit_decision;

  const run_id = ctx.run_id;
  const tenant_id = ctx.tenant_id;
  const channel_slug = switched;
  const legacyEmit = ctx.emit_decision;
  if (ctx.writes_suppressed) {
    return async () => "channel_action_suppressed";
  }
  if (ctx.redo) {
    return async () => {
      throw new ExpectedToolError(
        "redo_scope",
        "This run is redoing one action you were asked to rewrite. It cannot propose an account change as well. Rewrite the action; propose changes on a normal run of this channel.",
      );
    };
  }
  const topActionRun = ctx.top_action_run === true;
  const returned = new Set<string>();
  return async (decision_class: string, rawBody: unknown) => {
    let scope: { channel_slug: unknown; top_action: unknown } | null = null;
    if (topActionRun) {
      try {
        scope = await readTopActionScope(tenant_id, run_id);
      } catch (e) {
        throw new ExpectedToolError(
          "channel_stamp_unreadable",
          "Could not read this run's request, so there is no way to tell whether this change was asked for. Nothing was written — try again.",
          { cause: (e as Error).message },
        );
      }
    }
    if (scope && (scope.top_action == null || topActionRefusesClass(scope, decision_class))) {
      throw new ExpectedToolError(
        "top_action_scope",
        "This run does one thing the founder asked for. It cannot propose a different kind of change. Nothing was written.",
      );
    }
    const problem = scope ? topActionProposalProblem(scope, decision_class, rawBody) : null;
    if (problem) throw new ExpectedToolError("top_action_mismatch", problem);
    const cap = scope ? topActionProposalCap(scope) : null;
    if (cap !== null) {
      const { count, error } = await tenantClient(asTenantId(tenant_id))
        .from("channel_actions")
        .select("id", { count: "exact", head: true })
        .eq("run_id", run_id)
        .not("exec_class", "is", null);
      const filed = error ? Number.POSITIVE_INFINITY : (count ?? 0);
      if (Math.max(filed, returned.size) + (inflightByRun.get(run_id) ?? 0) >= cap) {
        throw new ExpectedToolError("top_action_cap", `This action files ${cap} card${cap === 1 ? "" : "s"} and it is already filed. Do not file it again.`);
      }
    }
    if (cap !== null) inflightByRun.set(run_id, (inflightByRun.get(run_id) ?? 0) + 1);
    let id: string;
    try {
      id = await write({
        tenant_id,
        run_id,
        channel_slug,
        decision_class,
        body: (rawBody ?? {}) as Record<string, unknown>,
        legacyEmit,
      });
    } finally {
      if (cap !== null) {
        const n = (inflightByRun.get(run_id) ?? 1) - 1;
        if (n > 0) inflightByRun.set(run_id, n);
        else inflightByRun.delete(run_id);
      }
    }
    if (id && id !== "channel_action_suppressed") returned.add(id);
    return id;
  };
}

const inflightByRun = new Map<string, number>();

export async function isUnstampedCgoRun(tenant_id: string, run_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("agent_slug, channel_slug")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`run read failed: ${error.message}`);
  const row = (data ?? {}) as { agent_slug?: unknown; channel_slug?: unknown };
  return row.agent_slug === "cgo" && !row.channel_slug;
}

export async function readsAsCgoRun(tenant_id: string, run_id: string, isCgoRun: typeof isUnstampedCgoRun = isUnstampedCgoRun): Promise<boolean> {
  try {
    return await isCgoRun(tenant_id, run_id);
  } catch (e) {
    console.warn(`[exec-emit] run ${run_id}: agent stamp unreadable (${(e as Error).message}); no cgo rail`);
    return false;
  }
}

const noLegacyRail: EmitDecisionFn = async () => {
  throw new ExpectedToolError("cgo_rail_no_legacy", "This channel files its cards on its own Actions tab only. Nothing was written.");
};

export async function cgoChannelRailEmit(
  ctx: ExecEmitCtx,
  channel: "tiktok_ads" | "reddit_ads",
  resolve: (c: ExecEmitCtx) => Promise<EmitDecisionFn | undefined>,
  isCgoRun: typeof isUnstampedCgoRun = isUnstampedCgoRun,
): Promise<EmitDecisionFn | undefined> {
  if (!ctx.emit_decision || !ctx.run_id) return undefined;
  if (!(await readsAsCgoRun(ctx.tenant_id, ctx.run_id, isCgoRun))) return undefined;
  if (ctx.writes_suppressed) return async () => "channel_action_suppressed";
  if (ctx.redo) {
    return async () => {
      throw new ExpectedToolError("redo_scope", "This run is redoing one action you were asked to rewrite. It cannot propose an account change as well.");
    };
  }
  const tenant_id = ctx.tenant_id;
  return async (decision_class, body) => {
    const { ensureCgoOrderRun } = await import("@/services/growth/cgo-ad-orders");
    const run_id = await ensureCgoOrderRun(tenant_id, channel);
    const emit = await resolve({ tenant_id, run_id, emit_decision: noLegacyRail });
    if (!emit || emit === noLegacyRail) {
      throw new ExpectedToolError("cgo_rail_no_writer", `Zavi could not find the ${channel} Actions tab writer, so nothing was proposed. This is a Zavi bug, not something to retry.`);
    }
    return emit(decision_class, body);
  };
}
