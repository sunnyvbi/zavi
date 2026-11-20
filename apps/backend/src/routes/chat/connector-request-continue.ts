
import type { Request, Response } from "express";
import { parseConnectorRequest, rowSatisfiesConnectorRequest, satisfyingSlugs } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const REUSABLE_CONTINUATION_STATUSES = new Set([
  "queued",
  "running",
  "success",
  "paused_awaiting_approval",
  "paused_awaiting_child",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function connectorRequestContinue(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const runId = String(req.params.run_id ?? "");
  if (!UUID_RE.test(runId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const sb = serverClientFromBearer(auth.access_token);

  const { data: run, error: runErr } = await sb
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, trigger, payload")
    .eq("id", runId)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (runErr) {
    res.status(500).json({ error: "run_read_failed" });
    return;
  }
  const origin = run as
    | { id: string; tenant_id: string; agent_slug: string; trigger: string | null; payload: unknown }
    | null;
  if (!origin || origin.tenant_id !== auth.tenant_id) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const payload =
    origin.payload && typeof origin.payload === "object"
      ? (origin.payload as Record<string, unknown>)
      : {};
  if (origin.trigger !== "chat" || typeof payload.thread_id !== "string" || !payload.thread_id) {
    res.status(409).json({ error: "not_continuable" });
    return;
  }

  const { data: rows, error: rowsErr } = await sb
    .from("agent_thread_messages")
    .select("meta")
    .eq("tenant_id", auth.tenant_id)
    .eq("agent_run_id", runId)
    .eq("sender_role", "assistant")
    .order("created_at", { ascending: false })
    .limit(5);
  if (rowsErr) {
    res.status(500).json({ error: "reply_read_failed" });
    return;
  }
  const request =
    (rows ?? [])
      .map((r) => parseConnectorRequest((r as { meta?: { connector_request?: unknown } }).meta?.connector_request))
      .find((r) => r !== null && r.run_id === runId) ?? null;
  if (!request) {
    res.status(404).json({ error: "no_connector_request" });
    return;
  }

  const { data: connRows, error: connErr } = await sb
    .from("connector_metadata")
    .select("slug, account_login, connected_at")
    .eq("tenant_id", auth.tenant_id)
    .in("slug", satisfyingSlugs(request.slug));
  if (connErr) {
    res.status(500).json({ error: "connector_read_failed" });
    return;
  }
  const conns = ((connRows ?? []) as Array<{
    slug: string;
    account_login?: string | null;
    connected_at?: string | null;
  }>).filter((r) => rowSatisfiesConnectorRequest(r, request.slug));
  const satisfied =
    request.mode === "reconnect"
      ? conns.some((c) => (c.connected_at ? Date.parse(c.connected_at) : NaN) > Date.parse(request.created_at))
      : conns.length > 0;
  if (!satisfied) {
    res.status(409).json({ error: "not_connected_yet" });
    return;
  }

  const { data: existing, error: existingErr } = await sb
    .from("agent_runs")
    .select("id, status")
    .eq("tenant_id", auth.tenant_id)
    .filter("payload->>connector_continue_of", "eq", runId)
    .order("enqueued_at", { ascending: false })
    .limit(10);
  if (existingErr) {
    res.status(500).json({ error: "run_read_failed" });
    return;
  }
  const already = ((existing ?? []) as Array<{ id?: string; status?: string }>).find((r) =>
    REUSABLE_CONTINUATION_STATUSES.has(r.status ?? ""),
  );
  if (already?.id) {
    res.status(200).json({ run_id: already.id });
    return;
  }

  const continued = await continueAfterConnect({
    tenant_id: auth.tenant_id,
    agent_slug: origin.agent_slug,
    origin_run_id: runId,
    origin_payload: payload,
    label: request.label,
    user_access_token: auth.access_token,
  });
  if (!continued.ok) {
    res.status(continued.status).json({ error: continued.error });
    return;
  }
  res.status(200).json({ run_id: continued.run_id });
}

export async function continueAfterConnect(args: {
  tenant_id: string;
  agent_slug: string;
  origin_run_id: string;
  origin_payload: Record<string, unknown>;
  label: string;
  user_access_token: string;
}): Promise<{ ok: true; run_id: string } | { ok: false; status: number; error: string }> {
  const { enqueueAgentRun } = await import("@/services/agents/runner");
  try {
    const { run_id } = await enqueueAgentRun({
      agent_slug: args.agent_slug,
      tenant_id: args.tenant_id,
      trigger: "chat",
      user_access_token: args.user_access_token,
      parent_run_id: args.origin_run_id,
      payload: {
        ...continuationPayload(args.origin_payload),
        connector_continue_of: args.origin_run_id,
        connector_continue_label: args.label,
      },
    });
    if (!run_id) return { ok: false, status: 503, error: "continue_not_enqueued" };
    return { ok: true, run_id };
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    if (name === "InsufficientCreditsError" || name === "BuildCreditsExhaustedError") {
      return { ok: false, status: 402, error: "insufficient_credits" };
    }
    if (name === "SandboxRepoAccessRequiredError") {
      return { ok: false, status: 409, error: "not_connected_yet" };
    }
    if (name === "PlanUpgradeRequiredError") {
      return { ok: false, status: 403, error: "plan_upgrade_required" };
    }
    console.warn(`[connector-request-continue] enqueue failed: ${(e as Error).message}`);
    return { ok: false, status: 500, error: "continue_failed" };
  }
}

const ONE_SHOT_KEYS = new Set([
  "resume_of_run_id",
  "internal_resume_turn",
  "command_slug",
  "connector_continue_of",
  "connector_continue_label",
]);

export function continuationPayload(origin: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(origin)) if (!ONE_SHOT_KEYS.has(k)) out[k] = v;
  return out;
}
