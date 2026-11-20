
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { tenantClient } from "@/services/tenant-client";
import {
  startConfirmedHeavyBuild,
  postBuildConfirmNote,
  startBuildNote,
} from "@/services/agents/heavy-build-confirm";

const START_BUILD_ROLES = ["owner", "admin"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildConfirmStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, START_BUILD_ROLES, res))) return;

  const threadId = String(req.params.thread_id ?? "");
  const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
  if (!UUID_RE.test(threadId) || !UUID_RE.test(nonce)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const { data: thread, error } = await tenantClient(auth.tenant_id)
    .from("agent_threads")
    .select("id, user_id, agent_slug")
    .eq("id", threadId)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "thread_read_failed" });
    return;
  }
  const t = thread as { user_id?: string; agent_slug?: string } | null;
  if (!t || t.user_id !== auth.user_id || t.agent_slug !== "operator") {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const result = await startConfirmedHeavyBuild({
    tenant_id: auth.tenant_id,
    thread_id: threadId,
    user_id: auth.user_id,
    nonce,
  });

  if (result.status === "started" || (result.status === "failed" && !result.retryable)) {
    await postBuildConfirmNote({
      tenant_id: auth.tenant_id,
      thread_id: threadId,
      body: startBuildNote(result),
      meta: { build_confirm_result: result.status },
    });
  }

  switch (result.status) {
    case "started":
    case "already_started":
      res.status(200).json({ status: result.status, run_id: result.run_id });
      return;
    case "insufficient_credits":
      res.status(402).json({ status: result.status });
      return;
    case "expired":
      res.status(409).json({ status: result.status });
      return;
    case "failed":
      res.status(500).json({ status: result.status, message: result.message });
      return;
  }
}
