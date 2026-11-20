
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { buildRunPanel, type RunActivityRow, type RunPanelState } from "@zavi/shared";
import { unionChildRuns } from "@/services/agents/run-status-projection";
import { isAskChildPayload } from "@/services/agents/ask-agent";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 8;
const MAX_EVENTS = 200;
const PANEL_KINDS = ["plan", "reasoning", "tool_call", "file_read", "file_edit", "file_create"];

function panelStateOf(status: string | null | undefined): RunPanelState {
  if (status === "queued" || status === "running" || !status) return "running";
  if (status === "cancelled") return "stopped";
  return status === "success" ? "finished" : "failed";
}

type ChildRun = {
  id: string;
  parent_run_id?: string | null;
  agent_slug: string;
  status: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  batch_id?: string | null;
  payload: {
    inherited_actor?: { actor_user_id?: unknown };
    operator_thread_id?: unknown;
    handoff_batch_id?: unknown;
  } | null;
};

const CHILD_COLS = "id, agent_slug, status, started_at, finished_at, batch_id, payload";

type Sb = ReturnType<typeof tenantClient>;

async function lineageChildren(sb: Sb, threadId: string, since: string): Promise<ChildRun[]> {
  try {
    const { data: parents, error: pErr } = await sb
      .from("agent_runs")
      .select("id")
      .eq("payload->>thread_id", threadId)
      .gte("enqueued_at", since)
      .limit(MAX_RUNS);
    if (pErr || !parents || parents.length === 0) return [];
    const { data: edges, error: eErr } = await sb
      .from("delegation_lineage")
      .select("child_run_id, parent_run_id")
      .in("parent_run_id", (parents as Array<{ id: string }>).map((p) => p.id))
      .limit(MAX_RUNS);
    if (eErr || !edges) return [];
    const childIds = (edges as Array<{ child_run_id: string | null }>)
      .map((e) => e.child_run_id)
      .filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
    if (childIds.length === 0) return [];
    const { data: runs, error: rErr } = await sb
      .from("agent_runs")
      .select(CHILD_COLS)
      .in("id", childIds)
      .limit(MAX_RUNS);
    if (rErr || !runs) return [];
    return (runs as unknown as ChildRun[]).map(run => ({
      ...run,
      parent_run_id: (edges as Array<{ child_run_id: string; parent_run_id?: string }>)
        .find(edge => edge.child_run_id === run.id)?.parent_run_id ?? null,
    }));
  } catch {
    return [];
  }
}

export async function threadHandoffProgress(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const threadId = req.params.thread_id;
  if (typeof threadId !== "string" || !UUID_RE.test(threadId)) {
    res.status(400).json({ error: { code: "bad_request", message: "thread_id must be a uuid" } });
    return;
  }

  const sb = tenantClient(asTenantId(auth.tenant_id));

  const { data: threadRows, error: threadErr } = await sb
    .from("agent_threads")
    .select("id, user_id")
    .eq("id", threadId)
    .limit(1);
  if (threadErr) {
    res.status(500).json({ error: { code: "thread_read_failed", message: threadErr.message } });
    return;
  }
  const thread = threadRows?.[0] as { user_id?: string | null } | undefined;
  if (!thread || thread.user_id !== auth.user_id) {
    res.status(404).json({ error: { code: "not_found", message: "No such thread." } });
    return;
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: runRows, error: runErr } = await sb
    .from("agent_runs")
    .select(CHILD_COLS)
    .eq("trigger", "handoff")
    .eq("payload->>operator_thread_id", threadId)
    .gte("enqueued_at", since)
    .order("enqueued_at", { ascending: false })
    .limit(MAX_RUNS);
  if (runErr) {
    res.status(200).json({ runs: [] });
    return;
  }

  const lineage = await lineageChildren(sb, threadId, since);
  const linked = unionChildRuns(
    (runRows ?? []) as unknown as ChildRun[],
    lineage,
  ).slice(0, MAX_RUNS);
  const mine = linked.filter(
    (r) => {
      if (r.payload?.inherited_actor?.actor_user_id !== auth.user_id) return false;
      if (r.status !== "success") return true;
      if (r.batch_id || isAskChildPayload(r.payload)) return false;
      return r.payload.operator_thread_id === threadId || !!r.payload.handoff_batch_id;
    },
  );

  const runs = await Promise.all(
    mine.map(async (run) => {
      const state = panelStateOf(run.status);
      const { data: eventRows } = await sb
        .from("thread_event")
        .select("id, kind, body")
        .eq("agent_run_id", run.id)
        .in("kind", PANEL_KINDS)
        .order("id", { ascending: false })
        .limit(MAX_EVENTS);
      const rows: RunActivityRow[] = ((eventRows ?? []) as Array<{
        id: number;
        kind: string;
        body: Record<string, unknown> | null;
      }>)
        .slice()
        .reverse()
        .map((r) => ({ id: String(r.id), kind: r.kind, body: r.body ?? {} }));
      return {
        run_id: run.id,
        parent_run_id: !run.batch_id && !isAskChildPayload(run.payload)
          && (run.payload?.operator_thread_id === threadId || !!run.payload?.handoff_batch_id)
          ? lineage.find(child => child.id === run.id)?.parent_run_id ?? null
          : null,
        agent_slug: run.agent_slug,
        status: run.status ?? "running",
        started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null,
        panel: buildRunPanel(rows, { state }),
      };
    }),
  );

  res.status(200).json({ runs });
}
