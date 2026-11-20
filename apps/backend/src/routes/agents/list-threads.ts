
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import { presentationStatus } from "@/services/agents/run-display-state";
import { attachThreadUnread } from "@/services/agents/thread-unread";

type AgentThreadRow = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
  last_message: string | null;
  run_status: string | null;
  run_outcome: { deliverable?: string | null } | null;
  pending: boolean | null;
};

export async function agentListThreads(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  const def = await loadAgentDefinition(slug, auth.tenant_id);
  if (!def) {
    res
      .status(404)
      .json({ error: { code: "unknown_agent", message: `no agent ${slug}` } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("list_agent_threads", {
    p_agent_slug: slug,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  const baseThreads = ((data ?? []) as AgentThreadRow[]).map((t) => {
    const { run_outcome, ...rest } = t;
    return {
      ...rest,
      presentation_status: rest.run_status
        ? presentationStatus({ status: rest.run_status, outcome: run_outcome })
        : null,
    };
  });

  const merged: Array<(typeof baseThreads)[number] | HomeCgoThreadRow> =
    slug === "cgo"
      ? mergeByActivity(baseThreads, await listHomeCgoThreads(supabase, auth.tenant_id, auth.user_id))
      : baseThreads;

  const threads = await attachThreadUnread(supabase, merged);
  res.json({ threads: await attachChannelOrigin(supabase, threads) });
}

export async function attachChannelOrigin<T extends { id: string }>(
  supabase: ReturnType<typeof serverClientFromBearer>,
  threads: T[],
): Promise<(T & { channel_slug: string | null; channel_action_id: string | null; from_email: boolean })[]> {
  const byId = new Map<string, { channel_slug: string; channel_action_id: string | null }>();
  const fromEmail = new Set<string>();
  if (threads.length > 0) {
    const { data, error } = await supabase
      .from("agent_threads")
      .select("id, channel_slug, channel_action_id, email_thread_id")
      .in(
        "id",
        threads.map((t) => t.id),
      );
    if (!error) {
      for (const r of (data ?? []) as Array<{ id: string; channel_slug: string | null; channel_action_id: string | null; email_thread_id: string | null }>) {
        if (r.channel_slug) byId.set(r.id, { channel_slug: r.channel_slug, channel_action_id: r.channel_action_id ?? null });
        if (r.email_thread_id) fromEmail.add(r.id);
      }
    }
  }
  return threads.map((t) => ({
    ...t,
    channel_slug: byId.get(t.id)?.channel_slug ?? null,
    channel_action_id: byId.get(t.id)?.channel_action_id ?? null,
    from_email: fromEmail.has(t.id),
  }));
}

export const HOME_CGO_SCAN = 100;
const LIST_CAP = 50;
const SNIPPET_CHARS = 120;
const MAX_SNIPPET_LOOKUPS = 12;

export type HomeCgoThreadRow = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
  last_message: string | null;
  run_status: string | null;
  pending: boolean | null;
  presentation_status: string | null;
  from_home: true;
};

export async function listHomeCgoThreads(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  user_id: string,
): Promise<HomeCgoThreadRow[]> {
  try {
    const { data: threads, error } = await supabase
      .from("agent_threads")
      .select("id, title, last_message_at, created_at")
      .eq("tenant_id", tenant_id)
      .eq("user_id", user_id)
      .eq("agent_slug", "operator")
      .is("deleted_at", null)
      .not("synthetic", "is", true)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(HOME_CGO_SCAN);
    if (error || !threads || threads.length === 0) return [];
    const rows = threads as Array<{ id: string; title: string | null; last_message_at: string | null; created_at: string | null }>;
    const { data: runs, error: runErr } = await supabase
      .from("agent_runs")
      .select("operator_thread_id:payload->>operator_thread_id")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", "cgo")
      .eq("trigger", "handoff")
      .in(
        "payload->>operator_thread_id",
        rows.map((t) => t.id),
      );
    if (runErr || !runs) return [];
    const answered = new Set((runs as Array<{ operator_thread_id: string | null }>).map((r) => r.operator_thread_id));
    const home = rows.filter((t) => answered.has(t.id));
    let lookups = 0;
    return await Promise.all(
      home.map(async (t) => {
        let last_message: string | null = null;
        if (!t.title && lookups++ < MAX_SNIPPET_LOOKUPS) {
          const { data: m } = await supabase
            .from("agent_thread_messages")
            .select("body")
            .eq("tenant_id", tenant_id)
            .eq("thread_id", t.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const body = (m as { body?: unknown } | null)?.body;
          last_message = typeof body === "string" ? body.slice(0, SNIPPET_CHARS) : null;
        }
        return { ...t, last_message, run_status: null, pending: false, presentation_status: null, from_home: true as const };
      }),
    );
  } catch {
    return [];
  }
}

export function mergeByActivity<A extends { last_message_at: string | null }, B extends { last_message_at: string | null }>(
  own: A[],
  home: B[],
): Array<A | B> {
  const at = (r: { last_message_at: string | null }) => (r.last_message_at ? Date.parse(r.last_message_at) || 0 : 0);
  return [...own, ...home].sort((x, y) => at(y) - at(x)).slice(0, LIST_CAP);
}
