
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const TRACE_BUCKET = "agent-run-traces";
const SIGNED_URL_TTL_SECONDS = 604800;
const RUN_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffRunTrace(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const runId = req.params.run_id;

  if (!RUN_ID_UUID_RE.test(runId)) {
    res
      .status(400)
      .json({ error: { code: "invalid_run_id", message: "run_id must be a UUID" } });
    return;
  }

  const sb = serviceClient();

  const { data: row, error: rowErr } = await sb
    .from("agent_run_trace")
    .select("run_id, tenant_id, storage_path, sha256, byte_size, event_count, created_at, expires_at")
    .eq("run_id", runId)
    .maybeSingle();
  if (rowErr) {
    res
      .status(500)
      .json({ error: { code: "trace_query_failed", message: rowErr.message } });
    return;
  }
  if (!row) {
    res.status(404).json({
      error: {
        code: "trace_not_found",
        message: "no trace for this run (not terminated, GC'd, or worker pending)",
      },
    });
    return;
  }

  const trace = row as {
    storage_path: string;
    sha256: string | null;
    byte_size: number | null;
    event_count: number | null;
    created_at: string;
    expires_at: string;
  };

  const msUntilExpiry = new Date(trace.expires_at).getTime() - Date.now();
  if (msUntilExpiry <= 0) {
    res.status(404).json({
      error: {
        code: "trace_expired",
        message: "trace is past its 30d retention deadline (pending GC sweep)",
      },
    });
    return;
  }

  const ttlSeconds = Math.max(
    1,
    Math.min(SIGNED_URL_TTL_SECONDS, Math.floor(msUntilExpiry / 1000)),
  );

  const { data: signed, error: signErr } = await sb.storage
    .from(TRACE_BUCKET)
    .createSignedUrl(trace.storage_path, ttlSeconds);
  if (signErr || !signed?.signedUrl) {
    res.status(500).json({
      error: {
        code: "sign_failed",
        message: signErr?.message ?? "could not sign trace url",
      },
    });
    return;
  }

  res.status(200).json({
    run_id: runId,
    signed_url: signed.signedUrl,
    expires_in: ttlSeconds,
    sha256: trace.sha256,
    byte_size: trace.byte_size,
    event_count: trace.event_count,
    trace_created_at: trace.created_at,
    trace_expires_at: trace.expires_at,
  });
}
