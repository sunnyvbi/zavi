
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import { attachThreadUnread } from "@/services/agents/thread-unread";
import { presentationStatus } from "@/services/agents/run-display-state";

const LIVE_RUN_STATUSES = ["queued", "running", "blocked"];

function threadPresentation(
  status: string,
  outcome: { deliverable?: string | null } | null,
): string {
  if (status === "blocked") return "running";
  return presentationStatus({ status, outcome });
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PREVIEW_CHARS = 120;
const MAX_PREVIEW_LOOKUPS = 12;
const MIN_THREAD_SCAN_PAGE_SIZE = 50;

type ThreadRow = {
  id: string;
  agent_slug: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
};

export function parseThreadLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export async function workspaceListThreads(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const limit = parseThreadLimit(req.query.limit);
  const supabase = serverClientFromBearer(auth.access_token);

  const resolved = new Map<string, string | null>();
  const rows: ThreadRow[] = [];
  const pageSize = Math.max(limit, MIN_THREAD_SCAN_PAGE_SIZE);
  let offset = 0;
  while (rows.length < limit) {
    const query = supabase
      .from("agent_threads")
      .select("id, agent_slug, title, last_message_at, created_at")
      .eq("user_id", auth.user_id)
      .eq("tenant_id", auth.tenant_id)
      .is("deleted_at", null)
      .not("synthetic", "is", true)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    const { data, error } =
      offset === 0
        ? await query.limit(pageSize)
        : await query.range(offset, offset + pageSize - 1);

    if (error) {
      res
        .status(500)
        .json({ error: { code: "query_failed", message: error.message } });
      return;
    }

    const page = (data ?? []) as ThreadRow[];
    const unresolvedSlugs = [
      ...new Set(
        page
          .map((thread) => thread.agent_slug)
          .filter((slug) => !resolved.has(slug)),
      ),
    ];
    await Promise.all(
      unresolvedSlugs.map(async (slug) => {
        const def = await loadAgentDefinition(slug, auth.tenant_id);
        resolved.set(slug, def?.slug ?? null);
      }),
    );
    rows.push(
      ...page.filter((thread) => Boolean(resolved.get(thread.agent_slug))),
    );

    if (page.length < pageSize) break;
    offset += pageSize;
  }
  rows.splice(limit);

  const untitled = rows
    .filter((t) => !t.title?.trim())
    .slice(0, MAX_PREVIEW_LOOKUPS)
    .map((t) => t.id);
  const previewById = new Map<string, string>();
  const loadPreviews = Promise.all(
    untitled.map(async (id) => {
      const { data: msg } = await supabase
        .from("agent_thread_messages")
        .select("body")
        .eq("thread_id", id)
        .eq("tenant_id", auth.tenant_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const body = (msg as { body: string | null } | null)?.body;
      if (body) previewById.set(id, body.slice(0, PREVIEW_CHARS));
    }),
  );

  const loadRunStatuses = (async () => {
    const byThread = new Map<
      string,
      { run_status: string; presentation_status: string }
    >();
    const slugs = [...new Set(rows.map((t) => t.agent_slug))];
    await Promise.all(
      slugs.map(async (slug) => {
        const { data, error } = await supabase.rpc("list_agent_threads_feed", {
          p_agent_slug: slug,
          p_limit: limit,
          p_before: null,
        });
        if (error) return;
        for (const run of (data ?? []) as Array<{
          id: string;
          run_status: string | null;
          run_outcome: { deliverable?: string | null } | null;
        }>) {
          if (!run.run_status) continue;
          byThread.set(run.id, {
            run_status: run.run_status,
            presentation_status: threadPresentation(run.run_status, run.run_outcome),
          });
        }
      }),
    );
    return byThread;
  })();

  const loadLiveRuns = (async () => {
    const byThread = new Map<string, string>();
    if (rows.length === 0) return byThread;
    const { data: liveRuns } = await supabase
      .from("agent_runs")
      .select("thread_id:payload->>thread_id, status")
      .eq("tenant_id", auth.tenant_id)
      .in("status", LIVE_RUN_STATUSES)
      .in(
        "payload->>thread_id",
        rows.map((t) => t.id),
      );
    for (const r of (liveRuns ?? []) as {
      thread_id: string | null;
      status: string;
    }[]) {
      if (r.thread_id) byThread.set(r.thread_id, r.status);
    }
    return byThread;
  })();

  const [, unread, feedStatusById, liveRunById] = await Promise.all([
    loadPreviews,
    attachThreadUnread(
      supabase,
      rows.map((t) => ({ id: t.id, last_message_at: t.last_message_at })),
    ),
    loadRunStatuses,
    loadLiveRuns,
  ]);
  const runStatusById = new Map(feedStatusById);
  for (const [threadId, status] of liveRunById) {
    runStatusById.set(threadId, {
      run_status: status,
      presentation_status: threadPresentation(status, null),
    });
  }
  const unreadById = new Map(unread.map((t) => [t.id, t.unread]));
  const unreadReplyById = new Map(unread.map((t) => [t.id, t.unread_reply]));

  const threads = rows.map((t) => {
    const run = runStatusById.get(t.id);
    return {
      id: t.id,
      agent_slug: resolved.get(t.agent_slug) ?? t.agent_slug,
      title: t.title,
      last_message_at: t.last_message_at,
      created_at: t.created_at,
      last_message: previewById.get(t.id) ?? null,
      run_status: run?.run_status ?? null,
      presentation_status: run?.presentation_status ?? null,
      pending: null,
      unread: unreadById.get(t.id) === true,
      unread_reply: unreadReplyById.get(t.id) ?? null,
    };
  });

  res.json({ threads });
}
