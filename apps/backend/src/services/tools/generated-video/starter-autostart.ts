import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { approveChannelAction } from "@/services/channels/exec-actions";
import { logEvent } from "@/services/logging/logEvent";

export type StarterAutostart = "started" | "not_starter" | "failed" | "capped" | "not_new";

export const STARTER_MAX_RENDERS = 1;

export type StarterCard = { actionId: string; kept: boolean };

export type StarterDeps = {
  readRun: (tenantId: string, runId: string) => Promise<{ trigger: string | null; payload: Record<string, unknown> | null } | null>;
  readRunCards: (tenantId: string, runId: string) => Promise<Array<{ id: string; position: number | null }>>;
  claim: (tenantId: string, actionId: string, runId: string) => Promise<boolean>;
  release: (tenantId: string, actionId: string) => Promise<void>;
  readCard: (tenantId: string, actionId: string) => Promise<{ status: string | null; exec_status: string | null } | null>;
  approve: typeof approveChannelAction;
  send: (evt: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  log: typeof logEvent;
};

async function readRun(tenantId: string, runId: string) {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("trigger, payload")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { trigger: string | null; payload: Record<string, unknown> | null } | null) ?? null;
}

async function readRunCards(tenantId: string, runId: string) {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id, position")
    .eq("run_id", runId)
    .eq("exec_class", "generated_video.render.v1");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; position: number | null }>;
}

async function claim(tenantId: string, actionId: string, runId: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "claim_starter_autostart", { p_action_id: actionId, p_run_id: runId });
  if (error) throw new Error(error.message);
  return data === true;
}

async function release(tenantId: string, actionId: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenantId)).from("starter_autostart_claims").delete().eq("action_id", actionId);
  if (error) throw new Error(error.message);
}

async function readCard(tenantId: string, actionId: string) {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("status, exec_status")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { status: string | null; exec_status: string | null } | null) ?? null;
}

const CARD_CLOSED_UNMADE = new Set(["rejected", "stale", "redone"]);

async function closedUnmade(d: StarterDeps, tenantId: string, actionId: string): Promise<boolean> {
  try {
    const card = await d.readCard(tenantId, actionId);
    if (!card || !card.status || !CARD_CLOSED_UNMADE.has(card.status)) return false;
    return !card.exec_status || card.exec_status === "failed";
  } catch {
    return false;
  }
}

const RAN_ALREADY = new Set(["already_executed", "exec_partial_no_retry", "exec_blocked_no_retry"]);

export function starterRank(cards: Array<{ id: string; position: number | null }>, actionId: string): number | null {
  const mine = cards.find((c) => c.id === actionId);
  if (!mine || typeof mine.position !== "number") return null;
  const at = mine.position;
  return cards.filter((c) => c.id !== actionId && (typeof c.position !== "number" || c.position < at || (c.position === at && c.id < actionId))).length;
}

async function send(evt: { id: string; name: string; data: Record<string, unknown> }): Promise<unknown> {
  const { inngest } = await import("@/../workers/client");
  return inngest.send(evt as never);
}

const DEFAULTS: StarterDeps = { readRun, readRunCards, claim, release, readCard, approve: approveChannelAction, send, log: logEvent };

export function starterOf(run: { trigger: string | null; payload: Record<string, unknown> | null } | null): string | null {
  if (!run || run.trigger !== "channel_recipe") return null;
  const by = run.payload?.starter_by;
  const req = run.payload?.starter_request;
  if (typeof by !== "string" || !/^[0-9a-f-]{36}$/i.test(by)) return null;
  if (typeof req !== "string" || !req.startsWith("ai-ugc-starters-")) return null;
  return by;
}

export async function autostartStarterVideo(
  tenantId: string,
  runId: string,
  card: StarterCard,
  deps: Partial<StarterDeps> = {},
): Promise<StarterAutostart> {
  const d = { ...DEFAULTS, ...deps };
  const { actionId } = card;
  let starterBy: string | null;
  try {
    starterBy = starterOf(await d.readRun(tenantId, runId));
  } catch (e) {
    void d.log({ level: "warn", source: "generated_video.starters", code: "starter.run_unreadable", message: (e as Error).message, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
  if (!starterBy) return "not_starter";
  if (card.kept) return "not_new";
  let rank: number | null;
  try {
    rank = starterRank(await d.readRunCards(tenantId, runId), actionId);
  } catch (e) {
    void d.log({ level: "warn", source: "generated_video.starters", code: "starter.cards_unreadable", message: (e as Error).message, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
  if (rank === null) return "not_new";
  if (rank >= STARTER_MAX_RENDERS) {
    void d.log({ level: "info", source: "generated_video.starters", code: "starter.cap_reached", message: `action=${actionId} rank=${rank + 1}`, tenant_id: tenantId, run_id: runId });
    return "capped";
  }
  try {
    if (!(await d.claim(tenantId, actionId, runId))) {
      void d.log({ level: "info", source: "generated_video.starters", code: "starter.already_started", message: `action=${actionId}`, tenant_id: tenantId, run_id: runId });
      return "capped";
    }
  } catch (e) {
    void d.log({ level: "warn", source: "generated_video.starters", code: "starter.history_unreadable", message: (e as Error).message, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
  try {
    const r = await d.approve(tenantId, { actionId, eventKey: `starter-${actionId}`, actorUserId: starterBy, source: null });
    if (!r.ok) {
      void d.log({ level: "warn", source: "generated_video.starters", code: "starter.approve_refused", message: `action=${actionId} code=${r.code}`, tenant_id: tenantId, run_id: runId });
      if (!RAN_ALREADY.has(r.code) && (r.code !== "illegal_transition" || (await closedUnmade(d, tenantId, actionId)))) {
        try {
          await d.release(tenantId, actionId);
        } catch (e) {
          void d.log({ level: "error", source: "generated_video.starters", code: "starter.release_failed", message: `action=${actionId}: ${(e as Error).message}`, tenant_id: tenantId, run_id: runId });
        }
      }
      return "failed";
    }
    if (!r.alreadyQueued || r.stillQueued) {
      await d.send({ id: `approve:${actionId}:${r.attempt}`, name: "channel-action.approved", data: { action_id: actionId } });
    }
    return "started";
  } catch (e) {
    void d.log({ level: "error", source: "generated_video.starters", code: "starter.autostart_failed", message: `action=${actionId}: ${(e as Error).message}`, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
}

export type ChatAutostart = "started" | "not_chat" | "not_first" | "failed";

export type ChatOrder = { founder: boolean; unverified: boolean; userId: string | null };

export function chatOrderer(order: ChatOrder | undefined): string | null {
  if (!order || order.founder !== true || order.unverified !== false) return null;
  const by = order.userId;
  if (typeof by !== "string" || !/^[0-9a-f-]{36}$/i.test(by)) return null;
  return by;
}

export async function autostartChatVideo(
  tenantId: string,
  runId: string,
  card: StarterCard,
  order: ChatOrder | undefined,
  deps: Partial<StarterDeps> = {},
): Promise<ChatAutostart> {
  const d = { ...DEFAULTS, ...deps };
  const { actionId } = card;
  const by = chatOrderer(order);
  if (!by) return "not_chat";
  if (card.kept) return "not_first";
  let rank: number | null;
  try {
    rank = starterRank(await d.readRunCards(tenantId, runId), actionId);
  } catch (e) {
    void d.log({ level: "warn", source: "generated_video.chat", code: "chat_video.cards_unreadable", message: (e as Error).message, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
  if (rank === null || rank >= STARTER_MAX_RENDERS) return "not_first";
  try {
    const r = await d.approve(tenantId, { actionId, eventKey: `chat-${actionId}`, actorUserId: by, source: null });
    if (!r.ok) {
      void d.log({ level: "warn", source: "generated_video.chat", code: "chat_video.approve_refused", message: `action=${actionId} code=${r.code}`, tenant_id: tenantId, run_id: runId });
      return "failed";
    }
    if (!r.alreadyQueued || r.stillQueued) {
      await d.send({ id: `approve:${actionId}:${r.attempt}`, name: "channel-action.approved", data: { action_id: actionId } });
    }
    return "started";
  } catch (e) {
    void d.log({ level: "error", source: "generated_video.chat", code: "chat_video.autostart_failed", message: `action=${actionId}: ${(e as Error).message}`, tenant_id: tenantId, run_id: runId });
    return "failed";
  }
}
