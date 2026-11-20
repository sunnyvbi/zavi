
import type { SupabaseClient } from "@supabase/supabase-js";

export type RunOwner = {
  owner_user_id: string | null;
  root_inherited_actor?: unknown;
  broken?: true;
};

export const NO_OWNER: RunOwner = { owner_user_id: null };
export const BROKEN: RunOwner = { owner_user_id: null, broken: true };

export const MAX_RESUME_HOPS = 5;

const RESUME_TRIGGERS: ReadonlySet<string> = new Set(["chat", "handoff"]);

export type RunHopRow = Row;

type Row = {
  agent_slug: string | null;
  trigger: string | null;
  enqueued_by: string | null;
  payload: Record<string, unknown>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

async function readRunRow(
  db: Pick<SupabaseClient, "from">,
  tenantId: string,
  id: string,
): Promise<Row | null> {
  const { data, error } = await db
    .from("agent_runs")
    .select("agent_slug, trigger, enqueued_by, payload")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`run owner: run read failed: ${error.message}`);
  if (!data) return null;
  const r = data as { agent_slug?: unknown; trigger?: unknown; enqueued_by?: unknown; payload?: unknown };
  return {
    agent_slug: str(r.agent_slug),
    trigger: str(r.trigger),
    enqueued_by: str(r.enqueued_by),
    payload: r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {},
  };
}

export function isResumeHop(run: Row, origin: Row | null): origin is Row {
  return (
    !!origin &&
    origin.agent_slug === run.agent_slug &&
    origin.trigger === run.trigger &&
    str(origin.payload.thread_id) === str(run.payload.thread_id)
  );
}

export async function resolveRunOwner(
  db: Pick<SupabaseClient, "from">,
  tenantId: string,
  runId: string,
): Promise<RunOwner> {
  const read = (id: string) => readRunRow(db, tenantId, id);

  const first = await read(runId);
  if (!first) return BROKEN;
  let run = first;
  for (let hop = 0; ; hop++) {
    if (run.enqueued_by) return { owner_user_id: run.enqueued_by };
    const prev = str(run.payload.resume_of_run_id);
    if (!RESUME_TRIGGERS.has(run.trigger ?? "")) return prev ? BROKEN : NO_OWNER;
    if (!prev) {
      if (run.trigger === "chat") return run.payload.origin === "staff_console" ? NO_OWNER : BROKEN;
      const owner = str(run.payload.user_id);
      const opThread = str(run.payload.operator_thread_id);
      if (!owner || !opThread) return BROKEN;
      const { data: thread, error } = await db
        .from("agent_threads")
        .select("user_id")
        .eq("id", opThread)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) throw new Error(`run owner: thread read failed: ${error.message}`);
      if (!thread || (thread as { user_id?: unknown }).user_id !== owner) return BROKEN;
      return run === first
        ? { owner_user_id: owner }
        : { owner_user_id: owner, root_inherited_actor: run.payload.inherited_actor };
    }
    if (hop >= MAX_RESUME_HOPS) return BROKEN;
    const origin = await read(prev);
    if (!isResumeHop(run, origin)) return BROKEN;
    run = origin;
  }
}

export type ChatTurnChain =
  | {
      ok: true;
      root_run_id: string;
      chain: string[];
      payloads: Record<string, unknown>[];
      user_message_id: string;
      thread_id: string;
      root_payload: Record<string, unknown>;
      root_enqueued_by: string | null;
    }
  | {
      ok: false;
      reason: "broken" | "not_chat";
    };

export async function resolveChatTurnChain(
  db: Pick<SupabaseClient, "from">,
  tenantId: string,
  runId: string,
): Promise<ChatTurnChain> {
  const first = await readRunRow(db, tenantId, runId);
  if (!first) return { ok: false, reason: "broken" };
  if (first.trigger !== "chat") return { ok: false, reason: "not_chat" };
  const chain: string[] = [runId];
  const payloads: Record<string, unknown>[] = [first.payload];
  const seen = new Set<string>([runId]);
  let run = first;
  for (let hop = 0; ; hop++) {
    const prev = run.enqueued_by ? null : str(run.payload.resume_of_run_id);
    if (!prev) {
      const user_message_id = str(run.payload.user_message_id);
      const thread_id = str(run.payload.thread_id);
      if (!user_message_id || !thread_id) return { ok: false, reason: "broken" };
      return {
        ok: true,
        root_run_id: chain[0],
        chain,
        payloads,
        user_message_id,
        thread_id,
        root_payload: run.payload,
        root_enqueued_by: run.enqueued_by,
      };
    }
    if (hop >= MAX_RESUME_HOPS || seen.has(prev)) return { ok: false, reason: "broken" };
    seen.add(prev);
    const origin = await readRunRow(db, tenantId, prev);
    if (!isResumeHop(run, origin)) return { ok: false, reason: "broken" };
    chain.unshift(prev);
    payloads.unshift(origin.payload);
    run = origin;
  }
}

export function runIdentityInputs(
  trigger: string,
  owner: RunOwner,
  payload: unknown,
  enqueuedBy: string | null | undefined,
): { userId: string | undefined; inheritedActor: unknown } {
  const userId = trigger === "chat" ? owner.owner_user_id ?? undefined : undefined;
  if (typeof enqueuedBy === "string" && enqueuedBy.length > 0) return { userId, inheritedActor: undefined };
  const own =
    payload && typeof payload === "object"
      ? (payload as { inherited_actor?: unknown }).inherited_actor
      : undefined;
  return { userId, inheritedActor: own ?? owner.root_inherited_actor };
}

export async function runMayUseThread(
  db: Pick<SupabaseClient, "from">,
  tenantId: string,
  runId: string,
  threadId: string,
): Promise<boolean> {
  const { owner_user_id, broken } = await resolveRunOwner(db, tenantId, runId);
  if (broken) return false;
  if (!owner_user_id) return true;
  const { data, error } = await db
    .from("agent_threads")
    .select("user_id")
    .eq("id", threadId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`run owner: thread read failed: ${error.message}`);
  return !!data && (data as { user_id?: unknown }).user_id === owner_user_id;
}

export function slackSenderOf(
  trigger: string,
  enqueuedBy: string | null | undefined,
  payload: unknown,
): { user?: unknown; team_id?: unknown } | undefined {
  if (trigger !== "slack" || (typeof enqueuedBy === "string" && enqueuedBy.length > 0)) return undefined;
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as { slack?: { user?: unknown; team_id?: unknown } }).slack;
}
