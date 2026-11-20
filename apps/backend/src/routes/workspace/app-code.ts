import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { isGoneSite, resolveAppForRequest, sendAppSelectionError, type RequestedApp } from "@/services/sites/app-identity";
import { isSafeRepoName, readLegacyAppRepo } from "@/services/sites/legacy-app";
import {
  AppCodeNotFound,
  AppCodePathRefused,
  AppCodeTooLarge,
  buildAppCodeZip,
  listAppCodeTree,
  readAppCodeFile,
} from "@/services/provisioning/app-code";

type RepoRef = { full_name: string; branch: string };

async function resolveRepo(req: Request, auth: AuthedRequest, res: Response): Promise<RepoRef | null> {
  let app: RequestedApp;
  try {
    app = await resolveAppForRequest(req, serverClientFromBearer(auth.access_token), auth.tenant_id);
  } catch (e) {
    sendAppSelectionError(res, e);
    return null;
  }
  if (app.kind === "legacy") return resolveLegacyRepo(auth.tenant_id, res);
  if (isGoneSite(app.site)) {
    res.status(404).json({ error: { code: "site_not_found", message: "This site was deleted." } });
    return null;
  }
  const full_name = typeof app.site.github_full_name === "string" ? app.site.github_full_name : "";
  if (!isSafeRepoName(full_name)) {
    res.status(409).json({
      error: { code: "no_provisioned_repo", message: "This site has no code yet." },
    });
    return null;
  }
  return { full_name, branch: "main" };
}

async function resolveLegacyRepo(tenant_id: string, res: Response): Promise<RepoRef | null> {
  let repo: RepoRef | null;
  try {
    repo = await readLegacyAppRepo(tenant_id);
  } catch (e) {
    console.error(`[app-code] legacy repo lookup failed for tenant ${tenant_id}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "repo_lookup_failed", message: "Could not look up the app code." } });
    return null;
  }
  if (!repo) {
    res.status(409).json({
      error: { code: "no_provisioned_repo", message: "This workspace has no built app code yet." },
    });
    return null;
  }
  return repo;
}

function umbrellaToken(res: Response): string | null {
  const token = process.env.GITHUB_PROVISION_TOKEN ?? null;
  if (!token) {
    res.status(503).json({
      error: { code: "code_not_configured", message: "Code view is not configured on the server." },
    });
  }
  return token;
}

export async function getWorkspaceAppCodeTree(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const repo = await resolveRepo(req, auth, res);
  if (!repo) return;
  const token = umbrellaToken(res);
  if (!token) return;
  try {
    const tree = await listAppCodeTree({ ...repo, token });
    res.json({ branch: repo.branch, name: repo.full_name.split("/").pop() ?? "", ...tree });
  } catch (e) {
    if (e instanceof AppCodeNotFound) {
      res.status(404).json({ error: { code: "repo_not_found", message: "The app repo was not found." } });
      return;
    }
    res.status(502).json({ error: { code: "code_read_failed", message: "Could not read the app code." } });
  }
}

export async function getWorkspaceAppCodeFile(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const repo = await resolveRepo(req, auth, res);
  if (!repo) return;
  const token = umbrellaToken(res);
  if (!token) return;
  try {
    const file = await readAppCodeFile({ ...repo, token, path: req.query.path });
    res.json(file);
  } catch (e) {
    if (e instanceof AppCodePathRefused) {
      res.status(e.reason === "secret_file" ? 403 : 400).json({
        error: {
          code: e.reason,
          message:
            e.reason === "secret_file"
              ? "Environment files are not shown here."
              : "That is not a valid file path.",
        },
      });
      return;
    }
    if (e instanceof AppCodeNotFound) {
      res.status(404).json({ error: { code: "file_not_found", message: "That file was not found." } });
      return;
    }
    res.status(502).json({ error: { code: "code_read_failed", message: "Could not read the file." } });
  }
}

export async function getWorkspaceAppCodeZip(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const repo = await resolveRepo(req, auth, res);
  if (!repo) return;
  const token = umbrellaToken(res);
  if (!token) return;
  try {
    const { zip, filename } = await buildAppCodeZip({ ...repo, token });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(zip));
  } catch (e) {
    if (e instanceof AppCodeNotFound) {
      res.status(404).json({ error: { code: "repo_not_found", message: "The app code was not found." } });
      return;
    }
    if (e instanceof AppCodeTooLarge) {
      res.status(413).json({
        error: { code: "code_too_large", message: "This app is too large to download here. Export it to GitHub instead." },
      });
      return;
    }
    console.error(`[app-code] zip failed for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    res.status(502).json({ error: { code: "code_read_failed", message: "Could not package the app code." } });
  }
}
