
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";

const postBody = z
  .object({
    user_id: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();

function mapRpcError(message: string): { status: number; code: string } {
  if (message.includes("not_authenticated")) return { status: 401, code: "not_authenticated" };
  if (message.includes("no_tenant_membership")) return { status: 403, code: "no_tenant" };
  if (message.includes("admin_only")) return { status: 403, code: "admin_only" };
  if (message.includes("target_not_a_member")) return { status: 404, code: "not_a_member" };
  if (message.includes("owner_email_always_on")) return { status: 409, code: "owner_email_always_on" };
  return { status: 500, code: "rpc_failed" };
}

export async function listEmailMembers(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("list_email_member_disabled");
  if (error) {
    const { status, code } = mapRpcError(error.message);
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.json({ disabled_user_ids: data ?? [] });
}

export async function setEmailMemberEnabled(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const parsed = postBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("set_email_member_enabled", {
    p_user_id: parsed.data.user_id,
    p_enabled: parsed.data.enabled,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message);
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.json({ user_id: parsed.data.user_id, enabled: data === true });
}
