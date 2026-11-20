
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

export async function submitSnapshot(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    provider?: string;
    period_start?: string;
    period_end?: string;
    payload?: unknown;
    source?: string;
  };

  if (!body.provider || !body.period_start || !body.period_end || body.payload === undefined) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "provider, period_start (YYYY-MM-DD), period_end (YYYY-MM-DD), payload required",
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("submit_ad_snapshot", {
    p_provider: body.provider,
    p_period_start: body.period_start,
    p_period_end: body.period_end,
    p_payload: body.payload,
    p_source: body.source ?? "manual_paste",
  });

  if (error) {
    const unsupportedProvider = (error as { code?: string }).code === "22023";
    res.status(unsupportedProvider ? 400 : 500).json({
      error: {
        code: unsupportedProvider ? "unsupported_provider" : "submit_failed",
        message: error.message,
      },
    });
    return;
  }

  res.json({ ok: true, snapshot_id: data as string });
}
