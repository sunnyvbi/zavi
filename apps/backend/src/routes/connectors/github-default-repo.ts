
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

export async function setDefaultRepoHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const raw = (req.body as { repo_full_name?: unknown } | undefined)?.repo_full_name;
  const repo_full_name = typeof raw === "string" ? raw.trim() : "";
  if (repo_full_name.length === 0) {
    res.status(400).json({
      error: {
        code: "missing_repo_full_name",
        message: "repo_full_name is required and must be a non-empty string",
      },
    });
    return;
  }
  if (repo_full_name.length > 200) {
    res.status(400).json({
      error: { code: "repo_full_name_too_long", message: "repo_full_name max 200 chars" },
    });
    return;
  }

  const sb = serverClientFromBearer(bearerToken(req));
  const { error } = await sb.rpc("set_github_default_repo", {
    p_tenant_id: auth.tenant_id,
    p_repo_full_name: repo_full_name,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23514") {
      const notSelected = /selected repositories/i.test(error.message ?? "");
      res.status(422).json({
        error: {
          code: notSelected ? "repo_not_selected" : "repo_not_connected",
          message: error.message,
        },
      });
      return;
    }
    if (code === "42501") {
      res.status(403).json({
        error: { code: "not_admin", message: error.message },
      });
      return;
    }
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }

  res.status(200).json({ ok: true, default_repo_full_name: repo_full_name });
}
