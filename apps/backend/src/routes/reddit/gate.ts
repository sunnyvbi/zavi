import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting } from "@/services/settings";
import { loadTenantRole } from "@/services/auth/tenant-role";

export async function redditWorkspaceV2Gate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  let enabled = true;
  try {
    enabled = await getBoolSetting("reddit_workspace_v2", auth.tenant_id);
  } catch (err) {
    console.error("[reddit-gate] flag read failed, allowing", err instanceof Error ? err.message : err);
  }
  if (!enabled) {
    res.status(404).json({ error: "not_found", reason: "disabled" });
    return;
  }
  next();
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_ROLES = new Set(["owner", "admin"]);

export async function redditWriteRoleGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (READ_METHODS.has((req.method ?? "GET").toUpperCase())) {
    next();
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  let role: string | null = null;
  try {
    role = await loadTenantRole(auth);
  } catch (err) {
    console.error("[reddit-gate] role read failed, refusing", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "role_check_failed", message: "We couldn't verify your access. Try again." });
    return;
  }
  if (!role || !WRITE_ROLES.has(role)) {
    res.status(403).json({ error: "forbidden", message: "Only an owner or an admin can change this." });
    return;
  }
  next();
}
