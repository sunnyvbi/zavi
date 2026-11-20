import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { clearBuildWatch, recordBuildWatch } from "@/services/build/build-watch";
import { serverClientFromBearer } from "@/services/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownBuildSession(accessToken: string, tenantId: string, sessionId: string): Promise<boolean> {
  const { data, error } = await serverClientFromBearer(accessToken)
    .from("conductor_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", sessionId)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id?: unknown } | null)?.id === sessionId;
}

export async function postBuildWatch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = req.body as { session_id?: unknown; left?: unknown } | undefined;
  const sessionId = body?.session_id;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    res.status(204).end();
    return;
  }
  let owned: boolean;
  try {
    owned = await ownBuildSession(auth.access_token, auth.tenant_id, sessionId);
  } catch (e) {
    console.warn(`[build-watch] session check failed for ${auth.tenant_id}: ${(e as Error).message}`);
    res.status(204).end();
    return;
  }
  if (!owned) {
    res.status(404).json({ error: { code: "build_session_not_found", message: "Build session not found." } });
    return;
  }
  try {
    if (body?.left === true) await clearBuildWatch(auth.tenant_id, sessionId);
    else await recordBuildWatch(auth.tenant_id, sessionId);
  } catch (e) {
    console.warn(`[build-watch] ${body?.left === true ? "clear" : "stamp"} failed for ${auth.tenant_id}: ${(e as Error).message}`);
  }
  res.status(204).end();
}
