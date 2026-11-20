
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { isTenantAdminOrOwner } from "@/services/auth/members";
import { serverClientFromBearer } from "@/services/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const querySchema = z.object({
  agent: z.string().regex(AGENT_RE).optional(),
  mode: z.enum(["direct", "connector"]).optional(),
  result: z.enum(["allowed", "refused", "failed", "pending"]).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  q: z.string().max(200).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  before_id: z.string().regex(UUID_RE).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  id: z.string().regex(UUID_RE).optional(),
});

const COLUMNS = [
  "id",
  "created_at",
  "finished_at",
  "caller_kind",
  "agent_slug",
  "feature",
  "run_id",
  "tool_name",
  "mode",
  "dialect",
  "operation",
  "query_text",
  "tables",
  "row_count",
  "sent_to_ai",
  "result",
  "refused_by",
  "reason",
  "totals_only",
  "ms",
].join(",");

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Row = { id: string; created_at: string };

export async function operatorDbAccessLog(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const client = serverClientFromBearer(auth.access_token);
  if (!(await isTenantAdminOrOwner(client, auth.user_id, auth.tenant_id))) {
    res.status(403).json({
      error: { code: "not_admin", message: "Only owners and admins can see the data access log." },
    });
    return;
  }

  const parsed = querySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: "Invalid filters." } });
    return;
  }
  const f = parsed.data;

  let query = client
    .from("data_access_log")
    .select(COLUMNS)
    .eq("tenant_id", auth.tenant_id);

  if (f.id) {
    query = query.eq("id", f.id);
  } else {
    const since = new Date(Date.now() - f.days * 86_400_000).toISOString();
    query = query.gte("created_at", since);
    if (f.before && f.before_id) {
      query = query.or(`created_at.lt."${f.before}",and(created_at.eq."${f.before}",id.lt.${f.before_id})`);
    } else if (f.before) {
      query = query.lt("created_at", f.before);
    }
  }
  if (f.agent === "background" || f.agent === "person") {
    query = query.eq("caller_kind", f.agent);
  } else if (f.agent) {
    query = query.eq("caller_kind", "agent").eq("agent_slug", f.agent);
  }
  if (f.mode) query = query.eq("mode", f.mode);
  if (f.result) query = query.eq("result", f.result);
  const q = f.q?.trim();
  if (q) query = query.ilike("query_text", `%${likeEscape(q)}%`);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(f.limit + 1);
  if (error) {
    res.status(500).json({ error: { code: "access_log_unavailable", message: "Could not load the data access log." } });
    return;
  }
  const all = (data ?? []) as unknown as Row[];
  const rows = all.slice(0, f.limit);
  const last = all.length > f.limit ? rows[rows.length - 1] : null;
  res.json({ rows, next_before: last?.created_at ?? null, next_before_id: last?.id ?? null });
}
