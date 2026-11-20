
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { emailToolConnected, requestSeed, retrySeed, type SeedRequest } from "./seed";

export type LearningAction = "add" | "edit" | "dismiss" | "restore" | "activate";

export const LEARNING_MESSAGES: Record<string, string> = {
  bad_request: "That did not make sense. Try again.",
  bad_text: "Write the lesson in one line, up to 300 characters.",
  not_authorized: "Only an owner or admin can change this list. A member can suggest a line.",
  not_found: "That line is no longer on the list.",
  card_changed: "This line changed since you opened it. Reload and try again.",
  list_full: "The list is full (12 lines). Remove one first.",
  suggestions_full: "There are already 20 suggestions waiting for an owner or admin. Ask one to look at them first.",
};

export type ListView = {
  items: Array<Record<string, unknown>>;
  dismissed: number;
  state: {
    last_run_at: string | null;
    full_skipped: number;
    kept_stronger: number;
    sources: Record<string, unknown>;
    seeded_at: string | null;
    seed_requested_at: string | null;
    updated_at: string | null;
  } | null;
  tools_connected: boolean | null;
};

export type ApiDeps = {
  rpc: (tenantId: string, name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  seed: (tenantId: string) => Promise<SeedRequest>;
  retry: (tenantId: string, actorUserId: string) => Promise<SeedRequest>;
  toolsConnected: (tenantId: string) => Promise<boolean>;
};
const LIVE: ApiDeps = {
  rpc: async (tenantId, name, args) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
    return { data, error };
  },
  seed: (tenantId) => requestSeed(tenantId),
  retry: (tenantId, actorUserId) => retrySeed(tenantId, actorUserId),
  toolsConnected: emailToolConnected,
};

export async function readLearnings(tenantId: string, userId: string, opts: { seed?: boolean } = {}, deps: ApiDeps = LIVE): Promise<ListView> {
  if (opts.seed !== false) await deps.seed(tenantId).catch(() => "failed");
  const [{ data, error }, toolsConnected] = await Promise.all([
    deps.rpc(tenantId, "list_email_learnings", { p_user_id: userId }),
    deps.toolsConnected(tenantId).catch(() => null),
  ]);
  if (error) throw new Error("list_email_learnings failed");
  const v = (data ?? {}) as Partial<ListView>;
  return {
    items: Array.isArray(v.items) ? v.items : [],
    dismissed: typeof v.dismissed === "number" ? v.dismissed : 0,
    state: v.state ?? null,
    tools_connected: toolsConnected,
  };
}

export async function lookAgain(tenantId: string, actorUserId: string, deps: ApiDeps = LIVE): Promise<SeedRequest> {
  return deps.retry(tenantId, actorUserId).catch((): SeedRequest => "failed");
}

export const LOOK_AGAIN_MESSAGES: Record<SeedRequest, string> = {
  queued: "Zavi is reading your past emails again.",
  pending: "Zavi is already reading your past emails.",
  done: "Zavi already read your past emails today. It reads them again when a connection changes, or tomorrow.",
  failed_today: "Zavi could not read your past emails today. An owner or admin can look again.",
  already_retried_today: "Zavi already tried again today. It reads your past emails again tomorrow, or when a connection changes.",
  not_authorized: "Only an owner or admin can ask Zavi to look again.",
  failed: "Zavi could not start that. Try again.",
};

export async function readDismissedLearnings(tenantId: string, deps: ApiDeps = LIVE): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await deps.rpc(tenantId, "list_dismissed_email_learnings", {});
  if (error) throw new Error("list_dismissed_email_learnings failed");
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

export async function setLearning(
  tenantId: string,
  userId: string,
  a: { action: LearningAction; id?: string | null; text?: string | null; version?: number | null },
  deps: ApiDeps = LIVE,
): Promise<{ ok: true; id: string; version: number; status: string } | { ok: false; code: string; message: string }> {
  const { data, error } = await deps.rpc(tenantId, "set_email_learning", {
    p_actor_user_id: userId,
    p_action: a.action,
    p_id: a.id ?? null,
    p_text: a.text ?? null,
    p_version: a.version ?? null,
  });
  if (error) throw new Error("set_email_learning failed");
  const out = (data ?? {}) as { ok?: boolean; code?: string; id?: string; version?: number; status?: string };
  if (!out.ok) {
    const code = out.code ?? "bad_request";
    return { ok: false, code, message: LEARNING_MESSAGES[code] ?? LEARNING_MESSAGES.bad_request };
  }
  return { ok: true, id: String(out.id), version: Number(out.version), status: String(out.status) };
}

export async function markLearningsSeen(tenantId: string, userId: string, items: Array<{ id: string; version: number }>, deps: ApiDeps = LIVE): Promise<number> {
  const { data, error } = await deps.rpc(tenantId, "mark_email_learnings_seen", { p_user_id: userId, p_items: items.slice(0, 50) });
  if (error) throw new Error("mark_email_learnings_seen failed");
  return typeof data === "number" ? data : 0;
}
