
import type { SupabaseClient } from "@supabase/supabase-js";
import { projectRunStatus, type ProjectableRun } from "./run-status-projection";

type Sb = SupabaseClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS = 60 * 60_000;
const MAX_CHILDREN = 5;

export type HandoffChild = ProjectableRun & { agent_slug: string | null };

export type HandoffRead<T> = { ok: true; value: T } | { ok: false };

export async function readRecentHandoffChildren(
  sb: Sb,
  tenant_id: string,
  thread_id: string | null | undefined,
): Promise<HandoffRead<HandoffChild[]>> {
  if (!thread_id || !UUID_RE.test(thread_id)) return { ok: true, value: [] };
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await sb
      .from("agent_runs")
      .select("id, agent_slug, status, outcome, parsed, payload")
      .eq("tenant_id", tenant_id)
      .eq("trigger", "handoff")
      .eq("payload->>operator_thread_id", thread_id)
      .gte("enqueued_at", since)
      .order("enqueued_at", { ascending: false })
      .limit(MAX_CHILDREN);
    if (error || !Array.isArray(data)) return { ok: false };
    return { ok: true, value: data as unknown as HandoffChild[] };
  } catch {
    return { ok: false };
  }
}

const WORKING_DB_STATUSES = ["queued", "running", "pending"];

export async function readWorkingHandoffChildSlugs(
  sb: Sb,
  tenant_id: string,
  thread_id: string | null | undefined,
): Promise<HandoffRead<string[]>> {
  if (!thread_id || !UUID_RE.test(thread_id)) return { ok: true, value: [] };
  try {
    const { data, error } = await sb
      .from("agent_runs")
      .select("agent_slug")
      .eq("tenant_id", tenant_id)
      .eq("trigger", "handoff")
      .eq("payload->>operator_thread_id", thread_id)
      .in("status", WORKING_DB_STATUSES);
    if (error || !Array.isArray(data)) return { ok: false };
    return {
      ok: true,
      value: (data as Array<{ agent_slug: string | null }>).map((r) => r.agent_slug ?? ""),
    };
  } catch {
    return { ok: false };
  }
}

const TENANT_WORKING_WINDOW_MS = 6 * 60 * 60_000;

export async function readTenantWorkingRunSlugs(
  sb: Sb,
  tenant_id: string,
  exclude_run_id: string | null | undefined,
): Promise<HandoffRead<string[]>> {
  try {
    const since = new Date(Date.now() - TENANT_WORKING_WINDOW_MS).toISOString();
    const { data, error } = await sb
      .from("agent_runs")
      .select("id, agent_slug")
      .eq("tenant_id", tenant_id)
      .in("status", WORKING_DB_STATUSES)
      .gte("enqueued_at", since)
      .order("enqueued_at", { ascending: false })
      .limit(200);
    if (error || !Array.isArray(data)) return { ok: false };
    return {
      ok: true,
      value: (data as Array<{ id: string; agent_slug: string | null }>)
        .filter((r) => r.id !== exclude_run_id && r.agent_slug !== "cgo")
        .map((r) => r.agent_slug ?? ""),
    };
  } catch {
    return { ok: false };
  }
}

function childLine(c: HandoffChild): string {
  const who = c.agent_slug || "specialist";
  const st = projectRunStatus(c);
  const links = st.links.map((l) => ` ${l.url}`).join("");
  switch (st.state) {
    case "working":
      return `- ${who}: still working on it.`;
    case "done":
      return `- ${who}: finished. ${st.title}${links}`;
    case "needs_input":
      return `- ${who}: stopped to ask the founder. ${st.title}`;
    case "couldnt":
      return `- ${who}: couldn't finish. Nothing was saved.`;
  }
}

export function handoffStatusBlock(children: readonly HandoffChild[]): string {
  if (children.length === 0) return "";
  return [
    "HAND-OFFS from this conversation in the last hour (server record, newest first; trust this over the chat history):",
    ...children.map(childLine),
    "Describe a hand-off only as this record shows it. If one couldn't finish, say so and offer to try again.",
  ].join("\n");
}
