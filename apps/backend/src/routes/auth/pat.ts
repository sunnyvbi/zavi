
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { mintPat } from "@/services/auth/pat";
import { serviceClient } from "@/services/supabase";

const MintBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(["read", "run", "admin"])).max(3).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

export async function authPatMint(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body: z.infer<typeof MintBody>;
  try {
    body = MintBody.parse(req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const scopes = body.scopes ?? ["read", "run"];

  if (scopes.includes("admin")) {
    const { data: roleRow } = await serviceClient()
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", auth.tenant_id)
      .eq("user_id", auth.user_id)
      .maybeSingle<{ role: string }>();
    if (!roleRow || (roleRow.role !== "owner" && roleRow.role !== "admin")) {
      res.status(403).json({
        error: {
          code: "admin_scope_forbidden",
          message: "Only tenant owners/admins can mint admin-scoped tokens.",
        },
      });
      return;
    }
  }

  const expires_at = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString()
    : null;

  try {
    const { id, raw, prefix } = await mintPat({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      name: body.name,
      scopes,
      expires_at,
    });
    res.status(201).json({
      id,
      token: raw,
      token_prefix: prefix,
      name: body.name,
      scopes,
      expires_at: expires_at ?? "+90d (default)",
      note: "Store this token now. It will not be shown again.",
    });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function authPatList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { data, error } = await serviceClient()
    .from("tenant_pats")
    .select("id,name,token_prefix,scopes,created_at,last_used_at,expires_at,revoked_at")
    .eq("user_id", auth.user_id)
    .eq("tenant_id", auth.tenant_id)
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error.message } });
    return;
  }
  res.json({ pats: data ?? [] });
}

export async function authPatRevoke(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { data, error } = await serviceClient().rpc("revoke_tenant_pat", {
    p_pat_id: req.params.id,
    p_user_id: auth.user_id,
  });
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error.message } });
    return;
  }
  if (data !== true) {
    res.status(404).json({ error: { code: "not_found", message: "PAT not found or already revoked" } });
    return;
  }
  res.status(204).send();
}
