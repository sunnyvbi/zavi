import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

const WRITE_ROLES = ["owner", "admin"] as const;
const AddBody = z.object({ email: z.string().min(1).max(320) }).strict();

type Out = { ok?: boolean; code?: unknown; [k: string]: unknown };

const REFUSAL: Record<string, { status: number; message: string }> = {
  not_authorized: { status: 403, message: "Only someone in this workspace can see its suppressed addresses." },
  bad_email: { status: 400, message: "That does not look like an email address." },
};

function refuse(res: Response, code: string): void {
  const r = REFUSAL[code] ?? { status: 409, message: "That could not be done." };
  res.status(r.status).json({ error: { code, message: r.message } });
}

function internal(res: Response, where: string): void {
  console.error(`[email-suppressions] ${where} failed`);
  res.status(500).json({ error: { code: "internal_error", message: "That did not work. Try again." } });
}

async function call(tenantId: string, name: string, args: Record<string, unknown>): Promise<Out | null> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error || !data || typeof data !== "object") return null;
  return data as Out;
}

export async function getEmailSuppressionsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const pageNum = Number(typeof req.query.page === "string" ? req.query.page : 1);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? Math.min(pageNum, 10000) : 1;
  try {
    const out = await call(auth.tenant_id, "list_email_suppressions", { p_user_id: auth.user_id, p_search: search || null, p_page: page });
    if (!out) return internal(res, "list");
    if (out.ok !== true) return refuse(res, typeof out.code === "string" ? out.code : "not_authorized");
    res.setHeader("Cache-Control", "no-store");
    res.json({ rows: Array.isArray(out.rows) ? out.rows : [], total: Number(out.total ?? 0), page: out.page, page_size: out.page_size, masked: out.masked === true });
  } catch {
    internal(res, "list");
  }
}

export async function postEmailSuppressionHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
    return;
  }
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const b = AddBody.safeParse(req.body ?? {});
  if (!b.success) return refuse(res, "bad_email");
  try {
    const out = await call(auth.tenant_id, "add_email_suppression", { p_user_id: auth.user_id, p_email: b.data.email });
    if (!out) return internal(res, "add");
    if (out.ok !== true) return refuse(res, typeof out.code === "string" ? out.code : "not_authorized");
    res.json({ added: out.added === true, email: out.email, reason: out.reason, created_at: out.created_at });
  } catch {
    internal(res, "add");
  }
}
