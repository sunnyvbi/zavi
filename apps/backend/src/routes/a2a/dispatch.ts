
import type { Request, Response } from "express";
import {
  enqueueAgentRun,
  getAgentRunById,
  FleetHaltedError,
} from "@/services/agents/runner";
import { validateAgentPayload } from "@/agents/_input-schemas";
import { stripReservedRunPayloadKeys } from "@/services/agents/reserved-payload";
import { asTenantId } from "@/services/tenant-client";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 90_000;

type AuthHeaderCarrier = { header(name: string): string | string[] | undefined };
export function checkSecret(req: AuthHeaderCarrier): boolean {
  const want = process.env.PRAXIS_A2A_SHARED_SECRET;
  if (!want) {
    console.warn("[a2a] PRAXIS_A2A_SHARED_SECRET unset; rejecting inbound A2A (fail-closed).");
    return false;
  }
  const header = String(req.header("authorization") ?? "");
  const m = /^A2A\s+(.+)$/.exec(header);
  return Boolean(m && m[1] === want);
}

export async function a2aDispatch(req: Request, res: Response): Promise<void> {
  if (!checkSecret(req)) {
    res.status(401).json({ error: { code: "bad_secret", message: "A2A shared-secret invalid" } });
    return;
  }

  const body = (req.body ?? {}) as {
    tenant_id?: string;
    agent_id?: string;
    payload?: unknown;
    sync?: boolean;
  };
  if (!body.tenant_id || !body.agent_id) {
    res.status(400).json({ error: { code: "bad_request", message: "tenant_id + agent_id required" } });
    return;
  }

  const validated = validateAgentPayload(body.agent_id, body.payload ?? null);
  if (!validated.ok) {
    res.status(400).json({
      error: {
        code: validated.error.code,
        message: validated.error.message,
        path: validated.error.path,
      },
    });
    return;
  }

  let run_id: string;
  try {
    const result = await enqueueAgentRun({
      agent_slug: body.agent_id,
      tenant_id: body.tenant_id,
      trigger: "a2a",
      payload: stripReservedRunPayloadKeys(validated.payload),
      cron_dedupe_key: null,
    });
    run_id = result.run_id;
  } catch (e) {
    if (e instanceof FleetHaltedError || (e as { code?: string }).code === "fleet_halted") {
      res.status(503).json({ error: { code: "fleet_halted", message: (e as Error).message } });
      return;
    }
    res.status(400).json({ error: { code: "enqueue_failed", message: (e as Error).message } });
    return;
  }

  if (!run_id) {
    res.status(409).json({ error: { code: "dedup_blocked", message: "duplicate" } });
    return;
  }

  if (body.sync === false) {
    res.status(202).json({ run_id });
    return;
  }

  const scopeTid = asTenantId(body.tenant_id);
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const run = await getAgentRunById(scopeTid, run_id);
    if (run && ["success", "parse_failed", "dispatch_error", "cancelled"].includes(run.status as string)) {
      res.json({
        run_id,
        status: run.status,
        parsed: run.parsed,
        output_text: run.output_text,
        cost_usd: run.cost_usd,
        cost_tokens: run.cost_tokens,
        parse_error: run.parse_error ?? null,
        error: run.error ?? null,
      });
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  res.status(504).json({ error: { code: "timeout", message: "agent run did not complete" }, run_id });
}
