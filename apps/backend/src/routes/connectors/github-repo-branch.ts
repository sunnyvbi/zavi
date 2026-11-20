
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import {
  assertReadRepoMembership,
  resolveInstallationId,
  listBranchesImpl,
} from "@/services/mcp/internal/github";

const MAX_BRANCH_PAGES = 10;

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

function splitRepo(full: string): { owner: string; repo: string } | null {
  const parts = full.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export async function listRepoBranchesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const raw = (req.query.repo_full_name as string | undefined) ?? "";
  const repo_full_name = raw.trim();
  const coord = splitRepo(repo_full_name);
  if (!coord) {
    res.status(400).json({
      error: {
        code: "bad_repo_full_name",
        message: "repo_full_name must be 'owner/repo'",
      },
    });
    return;
  }

  try {
    await assertReadRepoMembership(auth.tenant_id, coord.owner, coord.repo);
    const installation_id = await resolveInstallationId(auth.tenant_id);
    const names: string[] = [];
    for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
      const { branches } = await listBranchesImpl(
        auth.tenant_id,
        installation_id,
        { owner: coord.owner, repo: coord.repo, max_results: 100 },
        page,
      );
      for (const b of branches) if (b.name.length > 0) names.push(b.name);
      if (branches.length < 100) break;
    }

    const { data } = await serverClientFromBearer(bearerToken(req))
      .from("connector_metadata")
      .select("repo_default_branches")
      .eq("tenant_id", auth.tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    const current = (
      data as { repo_default_branches?: Record<string, string> } | null
    )?.repo_default_branches?.[repo_full_name];
    if (current && !names.includes(current)) names.unshift(current);

    res.status(200).json({ branches: names, current: current ?? null });
  } catch (e) {
    res.status(404).json({
      error: {
        code: "repo_not_accessible",
        message: (e as Error).message ?? "repo not accessible",
      },
    });
  }
}

export async function setRepoBranchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body as { repo_full_name?: unknown; branch?: unknown }) ?? {};
  const repo_full_name =
    typeof body.repo_full_name === "string" ? body.repo_full_name.trim() : "";
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (repo_full_name.length === 0 || branch.length === 0) {
    res.status(400).json({
      error: {
        code: "missing_field",
        message: "repo_full_name and branch are required",
      },
    });
    return;
  }

  const sb = serverClientFromBearer(bearerToken(req));
  const { error } = await sb.rpc("set_github_repo_base_branch", {
    p_tenant_id: auth.tenant_id,
    p_repo_full_name: repo_full_name,
    p_branch: branch,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "22023") {
      res.status(400).json({ error: { code: "unsafe_branch", message: error.message } });
      return;
    }
    if (code === "23514") {
      res.status(422).json({ error: { code: "repo_not_connected", message: error.message } });
      return;
    }
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  res.status(200).json({ ok: true, repo_full_name, branch });
}
