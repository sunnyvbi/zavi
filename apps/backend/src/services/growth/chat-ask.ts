
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { EnqueueGoalOwnerInput, EnqueueGoalOwnerResult } from "./goal-owner";

export const CHAT_ASK_PREFIX = "chat:";
export const CHAT_ASK_TOOL = "growth__start_channel_work";
export const WILL_QUEUE = "will_queue";
export const CHAT_ASK_MAX_CHARS = 2000;
export const CHAT_ASK_PENDING_HOURS = 6;

export type ChatAskRequest = { ask: string; channels: string[] };

export async function readChatAskWords(tenant_id: string, run_id: string, user_id: string | null): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id, trigger, enqueued_by, payload, agent_slug, enqueued_at")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`chat ask: run read failed: ${error.message}`);
  if (!data) return null;
  const { founderMessageOf } = await import("@/services/approvals/founder-message");
  const msg = await founderMessageOf({ ...(data as Record<string, unknown>), tenant_id } as never, { strict: true, anyAge: true });
  if (!msg || msg.ref.kind !== "chat") return null;
  if (user_id && msg.author_user_id !== user_id) return null;
  const text = msg.text.trim();
  return text ? text.slice(0, CHAT_ASK_MAX_CHARS) : null;
}

export async function ownChatAskReview(tenant_id: string, key: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "cgo")
    .eq("payload->>stage", "own_goals")
    .eq("payload->founder_reply->>reply_run_id", key)
    .limit(1);
  if (error) throw new Error(`chat ask: own review read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

export async function pendingChatAsk(tenant_id: string, now: Date = new Date()): Promise<{ id: string; key: string } | null> {
  const since = new Date(now.getTime() - CHAT_ASK_PENDING_HOURS * 3_600_000).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id, payload")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "cgo")
    .eq("payload->>stage", "own_goals")
    .eq("payload->>reason", "founder_reply")
    .in("status", ["queued", "running", "blocked"])
    .gte("enqueued_at", since)
    .order("enqueued_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`chat ask: in-flight review read failed: ${error.message}`);
  for (const r of (data ?? []) as Array<{ id: string; payload: { founder_reply?: { reply_run_id?: unknown } } | null }>) {
    const key = r.payload?.founder_reply?.reply_run_id;
    if (typeof key === "string" && key.startsWith(CHAT_ASK_PREFIX)) return { id: r.id, key };
  }
  return null;
}

export function decodeChatAskPreview(preview: unknown): { status?: unknown; request?: { ask?: unknown; channels?: unknown } } | null {
  let v: unknown = preview;
  for (let i = 0; i < 4; i++) {
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return null;
      }
      continue;
    }
    if (Array.isArray(v)) {
      const block = v.find((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string");
      if (!block) return null;
      v = (block as { text: string }).text;
      continue;
    }
    return v && typeof v === "object" ? (v as { status?: unknown; request?: { ask?: unknown; channels?: unknown } }) : null;
  }
  return null;
}

export function isChatAskQueuedTrace(t: { name?: unknown; status?: unknown; output_preview?: unknown } | null | undefined): boolean {
  if (!t || t.status !== "ok" || typeof t.name !== "string" || !isChatAskToolName(t.name)) return false;
  return decodeChatAskPreview(t.output_preview)?.status === WILL_QUEUE;
}

export function chatAskFromToolCalls(tool_calls: unknown): ChatAskRequest | null {
  return readChatAskCalls(tool_calls).request;
}

export function readChatAskCalls(tool_calls: unknown): { request: ChatAskRequest | null; unreadable: boolean } {
  let request: ChatAskRequest | null = null;
  let unreadable = false;
  if (!Array.isArray(tool_calls)) return { request, unreadable };
  for (const t of tool_calls as Array<{ name?: unknown; status?: unknown; output_preview?: unknown }>) {
    if (t?.status !== "ok" || typeof t.name !== "string" || !isChatAskToolName(t.name)) continue;
    const out = decodeChatAskPreview(t.output_preview);
    if (!out || typeof out.status !== "string") {
      unreadable = true;
      continue;
    }
    if (out.status !== WILL_QUEUE) continue;
    const ask = typeof out.request?.ask === "string" ? out.request.ask.trim().slice(0, 400) : "";
    const channels = Array.isArray(out.request?.channels)
      ? (out.request!.channels as unknown[]).filter((c): c is string => typeof c === "string" && /^[a-z0-9_-]{1,40}$/.test(c)).slice(0, 10)
      : [];
    request = { ask, channels };
  }
  return { request, unreadable };
}

function isChatAskToolName(name: string): boolean {
  if (name === CHAT_ASK_TOOL) return true;
  return /(^|__)growth__start_channel_work$/.test(name);
}

export type QueueChatAskOutcome =
  | { queued: true; review_run_id?: string }
  | {
      queued: false;
      why: "already_queued" | "busy" | "words_unreadable" | "daily_cap" | "autopilot_off" | "no_active_goals" | "no_credits" | "failed";
    };

export type QueueChatAskDeps = {
  words: (tenant_id: string, run_id: string, user_id: string | null) => Promise<string | null>;
  pending: (tenant_id: string) => Promise<{ id: string; key: string } | null>;
  own: (tenant_id: string, key: string) => Promise<string | null>;
  enqueue: (input: EnqueueGoalOwnerInput) => Promise<EnqueueGoalOwnerResult>;
};

const realDeps: QueueChatAskDeps = {
  words: readChatAskWords,
  pending: (t) => pendingChatAsk(t),
  own: ownChatAskReview,
  enqueue: async (input) => (await import("./goal-owner")).enqueueGoalOwnerRun(input),
};

export async function queueChatAskReview(
  args: { tenant_id: string; run_id: string; user_id: string | null; request: ChatAskRequest },
  deps: QueueChatAskDeps = realDeps,
): Promise<QueueChatAskOutcome> {
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: "cgo.chat_ask.queue", tenant_id: args.tenant_id, run_id: args.run_id, outcome, ...extra }));
  try {
    const key = `${CHAT_ASK_PREFIX}${args.run_id}`;
    const earlier = await deps.own(args.tenant_id, key);
    if (earlier) {
      log("queued_earlier", { review_run_id: earlier });
      return { queued: true, review_run_id: earlier };
    }
    const pending = await deps.pending(args.tenant_id);
    if (pending) {
      log("already_queued", { review_run_id: pending.id });
      return { queued: false, why: "already_queued" };
    }
    const words = await deps.words(args.tenant_id, args.run_id, args.user_id);
    if (!words) {
      log("words_unreadable");
      return { queued: false, why: "words_unreadable" };
    }
    const channels = args.request.channels.length ? ` Channels named: ${[...new Set(args.request.channels)].join(", ")}.` : "";
    const cgo_reading = `${args.request.ask}${channels}`.trim().slice(0, 600);
    const r = await deps.enqueue({
      tenant_id: args.tenant_id,
      reason: "founder_reply",
      require_autopilot: true,
      founder_reply: { via: "chat", text: words, reply_run_id: key, ...(cgo_reading ? { cgo_reading } : {}) },
    });
    if (r.enqueued) {
      log("queued", { review_run_id: r.run_id });
      return { queued: true, review_run_id: r.run_id };
    }
    log(r.skipped);
    if (r.skipped === "duplicate") {
      const own = await deps.own(args.tenant_id, key);
      return own ? { queued: true, review_run_id: own } : { queued: false, why: "busy" };
    }
    if (r.skipped === "daily_cap" || r.skipped === "autopilot_off" || r.skipped === "no_active_goals") return { queued: false, why: r.skipped };
    return { queued: false, why: "failed" };
  } catch (e) {
    const err = e as Error | null;
    const noCredits = err?.name === "InsufficientCreditsError" || /insufficient[_ ]credits/i.test(err?.message ?? "");
    console.warn(
      JSON.stringify({ event: "cgo.chat_ask.queue_failed", tenant_id: args.tenant_id, run_id: args.run_id, no_credits: noCredits, error: (err?.message ?? "").slice(0, 300) }),
    );
    return { queued: false, why: noCredits ? "no_credits" : "failed" };
  }
}

export function chatAskNotQueuedLine(why: Exclude<QueueChatAskOutcome, { queued: true }>["why"]): string {
  const head = "Correction: I did not queue that goal review after all";
  switch (why) {
    case "busy":
      return `${head}: another goal review started at the same moment, and this ask is not in it. Ask me again in a few minutes.`;
    case "already_queued":
      return `${head}: a review with an earlier ask from this chat is already queued or running, and this ask is not in it. Ask again once its cards are on the Growth page.`;
    case "daily_cap":
      return `${head}: today's goal reviews are used up. Ask me again tomorrow, or run the channel from its own page now.`;
    case "autopilot_off":
      return `${head}: Autopilot is off, so no channel work is handed out. Turn Autopilot on from the Growth page, or run the channel from its own page.`;
    case "no_active_goals":
      return `${head}: there is no active goal for a review to work on. Set a goal on the Growth page first.`;
    case "no_credits":
      return `${head}: there are not enough credits to run it. Add credits, then ask me again.`;
    case "words_unreadable":
    case "failed":
      return `${head}: it could not be started just now. Ask me again in a few minutes.`;
  }
}
