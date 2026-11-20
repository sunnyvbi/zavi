
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { logEventConfirmed } from "@/services/logging/logEvent";
import { WORKSPACE_OPENED_CODE } from "@/services/growth/tenant-idle";

export const OPENED_THROTTLE_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;
const lastLogged = new Map<string, number>();

export function resetWorkspaceOpenedThrottle(): void {
  lastLogged.clear();
}

export async function workspaceOpened(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const key = `${auth.tenant_id}:${auth.user_id}`;
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last === undefined || now - last >= OPENED_THROTTLE_MS) {
    if (lastLogged.size >= MAX_TRACKED) lastLogged.delete(lastLogged.keys().next().value as string);
    lastLogged.delete(key);
    lastLogged.set(key, now);
    void logEventConfirmed({ level: "info", source: "routes/workspace/opened", code: WORKSPACE_OPENED_CODE, tenant_id: auth.tenant_id }).then((r) => {
      if (!r.ok && lastLogged.get(key) === now) lastLogged.delete(key);
    });
  }
  res.status(204).end();
}
