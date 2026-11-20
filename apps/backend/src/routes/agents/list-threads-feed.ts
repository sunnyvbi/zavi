
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import { presentationStatus } from "@/services/agents/run-display-state";

type AgentThreadFeedRow = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
  last_message: string | null;
  run_status: string | null;
  pending: boolean | null;
  run_outcome: { deliverable?: string | null } | null;
  reply_count: number | null;
  first_user_message: string | null;
};

const DEFAULT_LIMIT = 50;

export async function agentListThreadsFeed(
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

  const rawLimit = req.query.limit;
  const parsedLimit =
    typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT;

  const rawBefore = req.query.before;
  let before: string | null = null;
  if (typeof rawBefore === "string" && rawBefore.length > 0) {
    if (Number.isNaN(new Date(rawBefore).getTime())) {
      res.status(400).json({
        error: {
          code: "bad_cursor",
          message: "before must be an ISO timestamp",
        },
      });
      return;
    }
    before = rawBefore;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("list_agent_threads_feed", {
    p_agent_slug: slug,
    p_limit: limit,
    p_before: before,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as AgentThreadFeedRow[];

  const threads = rows.map((t) => {
    const { run_outcome, ...rest } = t;
    return {
      ...rest,
      reply_count: typeof rest.reply_count === "number" ? rest.reply_count : 0,
      presentation_status: rest.run_status
        ? presentationStatus({ status: rest.run_status, outcome: run_outcome })
        : null,
    };
  });

  const last = threads.length > 0 ? threads[threads.length - 1] : null;
  const next_before =
    last && last.last_message_at && threads.length >= Math.min(limit, 200)
      ? last.last_message_at
      : null;

  res.json({ threads, next_before });
}
