
import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantClient, asTenantId } from "@/services/tenant-client";
import {
  claimHeavyDispatchPending,
  clearHeavyDispatchPending,
  findBuildConfirmCardRow as findCardRow,
  markBuildConfirmCard as markCard,
  restoreHeavyDispatchPending,
  readHeavyDispatchPending,
  parsePending,
  isFreshPending,
  pendingExpiresAt,
  type HeavyConfirmPending,
} from "@/services/agents/heavy-dispatch-pending";
import { creditsToUsd } from "@/services/agents/credits";

type Sb = Pick<SupabaseClient, "from">;

const PLAIN_YES = new Set([
  "y",
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "k",
  "go",
  "go ahead",
  "go for it",
  "do it",
  "proceed",
  "ok proceed",
  "okay proceed",
  "yes proceed",
  "please proceed",
  "start",
  "start it",
  "start the build",
  "start building",
  "build it",
  "yes build it",
  "yes start",
  "yes start it",
  "yes start the build",
  "yes please",
  "yes go ahead",
  "yes do it",
  "ok start",
  "ok go",
  "ok do it",
  "confirm",
  "confirmed",
  "approved",
  "lets go",
  "let's go",
  "ship it",
  "👍",
  "✅",
]);

export function isPlainBuildYes(message: string): boolean {
  const norm = message
    .toLowerCase()
    .replace(/[.,!?;:"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm || norm.length > 40) return false;
  return PLAIN_YES.has(norm);
}

export type BuildConfirmCard = {
  nonce: string;
  target: string;
  est_credits: number;
  est_usd: number;
  expires_at: string;
  status?: "started" | "replaced";
  run_id?: string | null;
};

export function buildConfirmCardFor(p: HeavyConfirmPending): BuildConfirmCard {
  return {
    nonce: p.nonce,
    target: p.target,
    est_credits: p.est_credits,
    est_usd: creditsToUsd(p.est_credits),
    expires_at: pendingExpiresAt(p),
  };
}

export async function readBuildConfirmCardForRun(
  params: { tenant_id: string; thread_id: string; run_id: string },
  sb?: Sb,
): Promise<BuildConfirmCard | null> {
  const p = await readHeavyDispatchPending(params, sb);
  if (!p || p.armed_run_id !== params.run_id || !isFreshPending(p)) return null;
  return buildConfirmCardFor(p);
}

export type StartBuildResult =
  | { status: "started"; run_id: string | null; est_credits: number; note?: string }
  | { status: "already_started"; run_id: string | null }
  | { status: "expired" }
  | { status: "insufficient_credits"; est_credits: number }
  | { status: "failed"; message: string; retryable: boolean };

type HandoffCall = (
  ctx: import("@/services/mcp/internal/praxis").PraxisToolCtx,
  tool_name: string,
  args: unknown,
) => Promise<{ ok: boolean; is_error?: boolean; content: string }>;

export type StartBuildDeps = {
  sb?: Sb;
  callHandoff?: HandoffCall;
};

function db(tenant_id: string, sb?: Sb): Sb {
  return sb ?? (tenantClient(asTenantId(tenant_id)) as unknown as Sb);
}

export async function postBuildConfirmNote(
  params: { tenant_id: string; thread_id: string; body: string; meta?: Record<string, unknown> },
  sb?: Sb,
): Promise<void> {
  try {
    const c = db(params.tenant_id, sb);
    await c.from("agent_thread_messages").insert({
      thread_id: params.thread_id,
      tenant_id: params.tenant_id,
      sender_role: "assistant",
      body: params.body,
      meta: params.meta ?? {},
      agent_run_id: null,
    });
    await c
      .from("agent_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id);
  } catch {
  }
}

async function armedUserMessageId(
  tenant_id: string,
  run_id: string | null,
  sb?: Sb,
): Promise<string | undefined> {
  if (!run_id) return undefined;
  try {
    const { data } = await db(tenant_id, sb)
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const id = ((data as { payload?: { user_message_id?: unknown } } | null)?.payload ?? {})
      .user_message_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function startConfirmedHeavyBuild(
  params: { tenant_id: string; thread_id: string; user_id: string; nonce: string },
  deps: StartBuildDeps = {},
): Promise<StartBuildResult> {
  const { sb } = deps;
  const pending = await claimHeavyDispatchPending(params, sb);
  if (!pending) {
    const row = await findCardRow(params.tenant_id, params.thread_id, params.nonce, sb).catch(
      () => null,
    );
    const card = (row?.meta.build_confirm ?? null) as { status?: unknown; run_id?: unknown } | null;
    if (card?.status === "started") {
      return {
        status: "already_started",
        run_id: typeof card.run_id === "string" ? card.run_id : null,
      };
    }
    return { status: "expired" };
  }

  const callHandoff: HandoffCall =
    deps.callHandoff ??
    (async (ctx, tool, args) => {
      const { callPraxisTool } = await import("@/services/mcp/internal/praxis");
      return callPraxisTool(ctx, tool, args);
    });

  const restore = () =>
    restoreHeavyDispatchPending(
      { tenant_id: params.tenant_id, thread_id: params.thread_id, pending },
      sb,
    );
  const notRestored = async (): Promise<StartBuildResult> => {
    await markCard(params.tenant_id, params.thread_id, pending.nonce, { status: "replaced" }, sb);
    return NOT_RESTORED;
  };

  const ctx = {
    tenant_id: params.tenant_id,
    run_id: pending.armed_run_id ?? undefined,
    agent_slug: "operator",
    trigger: "chat",
    chat_thread_id: params.thread_id,
    user_id: pending.user_id ?? params.user_id,
    heavy_confirm_preclaimed: true,
    user_turn_message_id: await armedUserMessageId(params.tenant_id, pending.armed_run_id, sb),
  };
  const args = {
    target_agent_slug: pending.target,
    intent: pending.intent,
    ...(pending.context ? { context: pending.context } : {}),
  };

  let result: { ok: boolean; is_error?: boolean; content: string };
  try {
    result = await callHandoff(ctx, "handoff", args);
  } catch (e) {
    const restored = await restore();
    if (!restored) return notRestored();
    const name = (e as Error)?.name ?? "";
    if (name === "InsufficientCreditsError" || name === "BuildCreditsExhaustedError") {
      return { status: "insufficient_credits", est_credits: pending.est_credits };
    }
    console.warn(`[heavy-build-confirm] dispatch threw: ${(e as Error)?.message}`);
    return { status: "failed", message: "Something went wrong starting the build. Try again.", retryable: true };
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
  }

  if (typeof body.error === "string" && ENQUEUED_ANYWAY.has(body.error)) {
    await markCard(params.tenant_id, params.thread_id, pending.nonce, { status: "started", run_id: null }, sb);
    return {
      status: "started",
      run_id: null,
      est_credits: pending.est_credits,
      note: "Started your build. If results do not show up here, ask me for the build status.",
    };
  }

  if (!result.ok || result.is_error || body.pending_confirmation === true) {
    if (!(await restore())) return notRestored();
    return { status: "failed", message: messageOf(body, "The build could not start. Try again."), retryable: true };
  }

  const run_id =
    [body.run_id, body.conductor_run_id, body.batch_id].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    ) ?? null;
  if (!run_id) {
    if (!(await restore())) return notRestored();
    return { status: "failed", message: messageOf(body, "The build could not start. Try again."), retryable: true };
  }

  await markCard(params.tenant_id, params.thread_id, pending.nonce, { status: "started", run_id }, sb);

  const failedTargets = Array.isArray(body.failed_targets)
    ? body.failed_targets.filter((t): t is string => typeof t === "string")
    : [];
  const note =
    failedTargets.length > 0
      ? `Started part of your build (about ${pending.est_credits.toLocaleString("en-US")} credits). These parts could not start: ${failedTargets.join(", ")}. Ask me to retry them.`
      : body.routed_to === "refine_product" || body.routed_to === "product_build"
        ? messageOf(body, "")
        : undefined;
  return { status: "started", run_id, est_credits: pending.est_credits, ...(note ? { note } : {}) };
}

const NOT_RESTORED: StartBuildResult = {
  status: "failed",
  message: "The build did not start. Ask me again and I'll set it up.",
  retryable: false,
};

const ENQUEUED_ANYWAY = new Set(["handoff_batch_persist_failed", "handoff_batch_join_unfired"]);

function messageOf(body: Record<string, unknown>, fallback: string): string {
  return typeof body.message === "string" && body.message ? body.message : fallback;
}

export function startBuildNote(r: StartBuildResult): string {
  switch (r.status) {
    case "started":
      if (r.note) return r.note;
      return `Started your build (about ${r.est_credits.toLocaleString("en-US")} credits). I'll post progress here as it goes.`;
    case "already_started":
      return "That build is already running. I'll post progress here as it goes.";
    case "expired":
      return "This build request was replaced or expired. Ask me again to start it.";
    case "insufficient_credits":
      return `You don't have enough credits for this build (about ${r.est_credits.toLocaleString("en-US")}). Top up in Billing, then click Start again.`;
    case "failed":
      return r.message;
  }
}

export const BUILD_CONFIRM_RETRY = "build_confirm_retry";

export async function maybeHandleBuildConfirmReply(
  params: { tenant_id: string; user_id: string; thread_id: string; message: string },
  deps: StartBuildDeps = {},
): Promise<string | null> {
  const { sb } = deps;
  const c = db(params.tenant_id, sb);
  const { data: thread, error: threadErr } = await c
    .from("agent_threads")
    .select("user_id, agent_slug, heavy_confirm_pending")
    .eq("id", params.thread_id)
    .eq("tenant_id", params.tenant_id)
    .maybeSingle();
  if (threadErr) return BUILD_CONFIRM_RETRY;
  const t = thread as
    | { user_id?: string; agent_slug?: string; heavy_confirm_pending?: unknown }
    | null;
  if (!t || t.user_id !== params.user_id || t.agent_slug !== "operator") return null;

  const pending = parsePending(t.heavy_confirm_pending);
  if (!pending || !isFreshPending(pending)) return null;

  if (!isPlainBuildYes(params.message)) {
    const cleared = await clearHeavyDispatchPending({ ...params, nonce: pending.nonce }, sb);
    if (!cleared) return BUILD_CONFIRM_RETRY;
    await markCard(params.tenant_id, params.thread_id, pending.nonce, { status: "replaced" }, sb);
    return null;
  }

  const { data: prev } = await c
    .from("agent_thread_messages")
    .select("meta")
    .eq("tenant_id", params.tenant_id)
    .eq("thread_id", params.thread_id)
    .eq("sender_role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const card = ((prev as { meta?: { build_confirm?: { nonce?: unknown } } } | null)?.meta
    ?.build_confirm ?? null) as { nonce?: unknown } | null;
  if (card?.nonce !== pending.nonce) return null;

  const { error: insErr } = await c.from("agent_thread_messages").insert({
    thread_id: params.thread_id,
    tenant_id: params.tenant_id,
    sender_role: "user",
    body: params.message,
    agent_run_id: null,
  });
  if (insErr) return null;

  const result = await startConfirmedHeavyBuild(
    { tenant_id: params.tenant_id, thread_id: params.thread_id, user_id: params.user_id, nonce: pending.nonce },
    deps,
  );
  await postBuildConfirmNote(
    {
      tenant_id: params.tenant_id,
      thread_id: params.thread_id,
      body: startBuildNote(result),
      meta: { build_confirm_result: result.status },
    },
    sb,
  );
  return `build_${result.status}`;
}
