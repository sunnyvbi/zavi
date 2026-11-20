

import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";

const CLIENT_REASON =
  "admin/tenant-threads: cross-tenant staff read-only chat-thread viewer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

const MESSAGE_COUNT_CAP = 50000;

type ThreadRow = {
  id: string;
  agent_slug: string;
  user_id: string | null;
  title: string | null;
  created_at: string;
  last_message_at: string;
  synthetic: boolean | null;
};

function intParam(raw: unknown, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function staffTenantThreadList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = req.params.tenant_id;

  if (!UUID_RE.test(tenant_id ?? "")) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a uuid" } });
    return;
  }

  const limit = Math.min(Math.max(intParam(req.query.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = intParam(req.query.offset, 0);
  const agentSlug = typeof req.query.agent_slug === "string" && req.query.agent_slug.length > 0
    ? req.query.agent_slug
    : null;

  const sb = staffCrossTenantClient(CLIENT_REASON);

  let q = sb
    .from("agent_threads")
    .select("id, agent_slug, user_id, title, created_at, last_message_at, synthetic")
    .eq("tenant_id", tenant_id)
    .is("deleted_at", null)
    .order("last_message_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (agentSlug) q = q.eq("agent_slug", agentSlug);

  const { data: page, error: pageErr } = await q;
  if (pageErr) {
    res.status(500).json({ error: { code: "threads_query_failed", message: pageErr.message } });
    return;
  }
  const threads = (page ?? []) as ThreadRow[];

  const countByThread = new Map<string, number>();
  if (threads.length > 0) {
    const ids = threads.map((t) => t.id);
    const { data: msgs, error: mErr } = await sb
      .from("agent_thread_messages")
      .select("thread_id")
      .eq("tenant_id", tenant_id)
      .in("thread_id", ids)
      .limit(MESSAGE_COUNT_CAP);
    if (mErr) {
      res.status(500).json({ error: { code: "message_count_failed", message: mErr.message } });
      return;
    }
    for (const m of (msgs ?? []) as Array<{ thread_id: string }>) {
      countByThread.set(m.thread_id, (countByThread.get(m.thread_id) ?? 0) + 1);
    }
  }

  const hasMore = threads.length === limit;

  res.json({
    items: threads.map((t) => ({
      id: t.id,
      agent_slug: t.agent_slug,
      user_id: t.user_id,
      title: t.title,
      created_at: t.created_at,
      last_message_at: t.last_message_at,
      synthetic: t.synthetic === true,
      message_count: countByThread.get(t.id) ?? 0,
    })),
    has_more: hasMore,
    next_offset: hasMore ? offset + threads.length : null,
  });
}

export async function staffTenantThreadRead(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const thread_id = req.params.thread_id;

  if (!UUID_RE.test(tenant_id ?? "")) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a uuid" } });
    return;
  }
  if (!UUID_RE.test(thread_id ?? "")) {
    res.status(400).json({ error: { code: "invalid_thread_id", message: "thread_id must be a uuid" } });
    return;
  }

  const sb = staffCrossTenantClient(CLIENT_REASON);

  const { data: thread, error: thErr } = await sb
    .from("agent_threads")
    .select("id, tenant_id, agent_slug, user_id, title, created_at, last_message_at, deleted_at, synthetic")
    .eq("id", thread_id)
    .maybeSingle<{
      id: string;
      tenant_id: string;
      agent_slug: string;
      user_id: string | null;
      title: string | null;
      created_at: string;
      last_message_at: string;
      deleted_at: string | null;
      synthetic: boolean | null;
    }>();
  if (thErr) {
    res.status(500).json({ error: { code: "thread_query_failed", message: thErr.message } });
    return;
  }
  if (!thread) {
    res.status(404).json({ error: { code: "thread_not_found", message: thread_id } });
    return;
  }
  if (thread.tenant_id !== tenant_id) {
    res.status(403).json({
      error: { code: "thread_tenant_mismatch", message: "thread does not belong to this tenant" },
    });
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
    .select("id, status, agent_slug, enqueued_at, finished_at, error, trigger")
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

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "staff.thread.read",
    target_table: "agent_threads",
    target_id: thread_id,
    tenant_id,
    meta: { agent_slug: thread.agent_slug, message_count: (messages ?? []).length },
  });

  res.json({
    thread: {
      id: thread.id,
      agent_slug: thread.agent_slug,
      user_id: thread.user_id,
      title: thread.title,
      created_at: thread.created_at,
      last_message_at: thread.last_message_at,
      deleted: thread.deleted_at != null,
      synthetic: thread.synthetic === true,
    },
    messages: messages ?? [],
    runs: runs ?? [],
    decisions,
  });
}
