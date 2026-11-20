
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { inngest } from "@/../workers/client";

async function enqueueProfileRebuild(tenant_id: string): Promise<void> {
  try {
    await inngest.send({
      name: "repo.profile.build.requested",
      data: { tenant_id },
    });
  } catch (e) {
    console.warn(
      `[connectors/github] enqueue repo-profile-build after selection change failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

export async function setSelectedReposHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const raw = (req.body as { repo_ids?: unknown } | undefined)?.repo_ids;
  if (!Array.isArray(raw)) {
    res.status(400).json({
      error: {
        code: "missing_repo_ids",
        message: "repo_ids is required and must be an array of GitHub repo ids",
      },
    });
    return;
  }
  const repo_ids: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({
        error: {
          code: "bad_repo_id",
          message: `repo_ids must be positive integers; got ${JSON.stringify(v)}`,
        },
      });
      return;
    }
    repo_ids.push(n);
  }
  if (repo_ids.length > 1000) {
    res.status(400).json({
      error: { code: "too_many_repo_ids", message: "repo_ids max 1000" },
    });
    return;
  }
  const deduped = Array.from(new Set(repo_ids));

  const sb = serverClientFromBearer(bearerToken(req));
  const { error } = await sb.rpc("set_github_selected_repos", {
    p_tenant_id: auth.tenant_id,
    p_repo_ids: deduped,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23514") {
      res.status(422).json({
        error: { code: "repo_not_in_installation", message: error.message },
      });
      return;
    }
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    if (code === "22023") {
      res.status(400).json({ error: { code: "bad_request", message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await enqueueProfileRebuild(auth.tenant_id);
  res.status(200).json({ ok: true, selected_repo_ids: deduped });
}

export async function clearSelectedReposHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(bearerToken(req));
  const { error } = await sb.rpc("clear_github_selected_repos", {
    p_tenant_id: auth.tenant_id,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await enqueueProfileRebuild(auth.tenant_id);
  res.status(200).json({ ok: true, selected_repo_ids: null });
}
