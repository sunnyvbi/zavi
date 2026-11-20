
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { validateAllowlistEntry } from "@/email/allowlist";

const postBody = z
  .object({
    value: z.string().trim().min(1).max(320),
  })
  .strict();

function mapRpcError(message: string): { status: number; code: string } {
  if (message.includes("not_authenticated")) return { status: 401, code: "not_authenticated" };
  if (message.includes("no_tenant_membership")) return { status: 403, code: "no_tenant" };
  if (message.includes("admin_only")) return { status: 403, code: "admin_only" };
  if (message.includes("allowlist_cap_reached")) return { status: 409, code: "cap_reached" };
  if (message.includes("bad_kind") || message.includes("bad_value")) {
    return { status: 400, code: "invalid_body" };
  }
  return { status: 500, code: "rpc_failed" };
}

export async function listEmailAllowlist(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("list_email_allowlist");
  if (error) {
    const { status, code } = mapRpcError(error.message);
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.json({ entries: data ?? [] });
}

export async function addEmailAllowlistEntry(req: Request, res: Response): Promise<void> {
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

  const v = validateAllowlistEntry(parsed.data.value);
  if (!v.ok) {
    res.status(400).json({ error: { code: v.code, message: v.message } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("add_email_allowlist_entry", {
    p_kind: v.entry.kind,
    p_value: v.entry.value,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message);
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.status(201).json({ id: data, kind: v.entry.kind, value: v.entry.value });
}

export async function removeEmailAllowlistEntry(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: { code: "invalid_id", message: "id must be a uuid" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("remove_email_allowlist_entry", { p_id: id.data });
  if (error) {
    const { status, code } = mapRpcError(error.message);
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.json({ removed: data === true });
}
