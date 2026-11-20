
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { STAFF_CONSOLE_ALLOWED_SLUG, isStaffOrInternalTenant } from "./staff-console-shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffAgentThreadRead(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const slug = req.params.slug;
  const thread_id = req.params.thread_id;

  if (slug !== STAFF_CONSOLE_ALLOWED_SLUG) {
    res.status(400).json({
      error: {
        code: "slug_not_allowed",
        message: `The staff console v1 only reads the '${STAFF_CONSOLE_ALLOWED_SLUG}' agent.`,
      },
    });
    return;
  }

  if (!UUID_RE.test(thread_id ?? "")) {
    res.status(400).json({ error: { code: "invalid_thread_id", message: "thread_id must be a uuid" } });
    return;
  }

  if (await isStaffOrInternalTenant(tenant_id)) {
    res.status(403).json({
      error: {
        code: "tenant_not_operable",
        message: "The staff console v1 operates on customer tenants only.",
      },
    });
    return;
  }

  const sb = serviceClient();

  const { data: thread, error: thErr } = await sb
    .from("agent_threads")
    .select("id, tenant_id, agent_slug, title, created_at, last_message_at, deleted_at")
    .eq("id", thread_id)
    .maybeSingle<{
      id: string;
      tenant_id: string;
      agent_slug: string;
      title: string | null;
      created_at: string;
      last_message_at: string;
      deleted_at: string | null;
    }>();
  if (thErr) {
    res.status(500).json({ error: { code: "thread_query_failed", message: thErr.message } });
    return;
  }
  if (!thread) {
    res.status(404).json({ error: { code: "thread_not_found", message: thread_id } });
    return;
  }
  if (thread.tenant_id !== tenant_id || thread.agent_slug !== slug) {
    res.status(403).json({ error: { code: "thread_tenant_mismatch", message: "thread does not belong to this tenant" } });
    return;
  }

  const { data: messages, error: msgErr } = await sb
    .from("agent_thread_messages")
    .select("id, sender_role, body, agent_run_id, attachments, meta, created_at")
    .eq("thread_id", thread_id)
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: true });
  if (msgErr) {
    res.status(500).json({ error: { code: "messages_query_failed", message: msgErr.message } });
    return;
  }

  const { data: runs, error: runErr } = await sb
    .from("agent_runs")
    .select("id, status, agent_slug, enqueued_at, trigger")
    .eq("tenant_id", tenant_id)
    .eq("payload->>thread_id", thread_id)
    .order("enqueued_at", { ascending: true });
  if (runErr) {
    res.status(500).json({ error: { code: "runs_query_failed", message: runErr.message } });
    return;
  }
  const runIds = (runs ?? []).map((r) => (r as { id: string }).id);

  let decisions: unknown[] = [];
  if (runIds.length > 0) {
    const { data: decRows, error: decErr } = await sb
      .from("decisions")
      .select("id, agent_run_id, decision_class, status, body, approved_by_source, emitted_at")
      .eq("tenant_id", tenant_id)
      .in("agent_run_id", runIds)
      .order("emitted_at", { ascending: true });
    if (decErr) {
      res.status(500).json({ error: { code: "decisions_query_failed", message: decErr.message } });
      return;
    }
    decisions = decRows ?? [];
  }

  res.json({
    thread: {
      id: thread.id,
      title: thread.title,
      created_at: thread.created_at,
      last_message_at: thread.last_message_at,
      deleted: thread.deleted_at != null,
    },
    messages: messages ?? [],
    runs: runs ?? [],
    decisions,
  });
}
