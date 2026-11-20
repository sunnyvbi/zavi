
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { isTenantAdminOrOwner, canUserAccessAgent } from "@/services/auth/members";
import {
  authorTenantRoutine,
  approveTenantRoutine,
} from "@/services/routines/tenant-authoring";

const AuthorBody = z.object({
  agent_slug: z.string().min(1).max(64),
  routine_name: z.string().min(1).max(120),
  routine_spec: z.unknown(),
  granted_tool_names: z.array(z.string().min(1)).min(1).max(64),
});

const LIST_COLS =
  "id, agent_slug, routine_name, status, provenance_origin, emitted_tool_name, " +
  "granted_tool_names, run_count, created_by, approved_by, approved_at, " +
  "created_at";

export async function routinesList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { data, error } = await serviceClient()
      .from("tenant_routines")
      .select(LIST_COLS)
      .eq("tenant_id", auth.tenant_id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      res.status(500).json({ error: { code: "read_failed", message: error.message } });
      return;
    }
    res.json({ items: data ?? [] });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function routineAuthor(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = AuthorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
    return;
  }
  const sb = serviceClient();

  if (!(await isTenantAdminOrOwner(sb, auth.user_id, auth.tenant_id))) {
    res.status(403).json({ error: { code: "not_admin", message: "only a tenant admin or owner can author executable routines" } });
    return;
  }
  if (!(await canUserAccessAgent(sb, auth.user_id, auth.tenant_id, parsed.data.agent_slug))) {
    res.status(403).json({ error: { code: "no_agent_access", message: `no access to agent '${parsed.data.agent_slug}'` } });
    return;
  }

  const result = await authorTenantRoutine(
    {
      tenant_id: auth.tenant_id,
      agent_slug: parsed.data.agent_slug,
      routine_name: parsed.data.routine_name,
      routine_spec: parsed.data.routine_spec,
      granted_tool_names: parsed.data.granted_tool_names,
      created_by: auth.user_id,
    },
    sb,
  );
  if (!result.ok) {
    res.status(400).json({ error: { code: "author_failed", message: result.reason ?? "author failed" } });
    return;
  }
  res.status(201).json({ id: result.id, status: "candidate" });
}

export async function routineApprove(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid routine id" } });
    return;
  }
  const sb = serviceClient();
  if (!(await isTenantAdminOrOwner(sb, auth.user_id, auth.tenant_id))) {
    res.status(403).json({ error: { code: "not_admin", message: "only a tenant admin or owner can approve executable routines" } });
    return;
  }

  const result = await approveTenantRoutine(id, auth.tenant_id, auth.user_id, sb);
  if (!result.approved) {
    res.status(409).json({ error: { code: "approve_failed", message: result.reason } });
    return;
  }
  res.json({ approved: true, id });
}
