
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const DAYS = 30;
const LIMIT = 50;
export const MUTE_KEY_RE = /^(\*|[a-z0-9_]{1,64}|read_failed:[a-z0-9_]{1,40})$/;

export async function getWhatMoved(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sb = serverClientFromBearer(auth.access_token);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const [inc, mv, mutes] = await Promise.all([
    sb
      .from("metric_incidents")
      .select("id, family, status, primary_key, severity, opened_on, last_eval_on, recovered_on, notices, last_notice_mode, last_message_subject")
      .eq("tenant_id", auth.tenant_id)
      .gte("last_eval_on", since)
      .order("opened_on", { ascending: false })
      .limit(LIMIT),
    sb
      .from("metric_moves")
      .select("metric_id, move_date, direction, good, severity, value, typical")
      .eq("tenant_id", auth.tenant_id)
      .gte("move_date", since)
      .order("move_date", { ascending: false })
      .limit(LIMIT),
    sb.from("metric_alert_mutes").select("mute_key, created_at").eq("tenant_id", auth.tenant_id).limit(200),
  ]);
  const err = inc.error ?? mv.error ?? mutes.error;
  if (err) {
    res.status(500).json({ error: { code: "what_moved_failed", message: err.message } });
    return;
  }
  res.json({ incidents: inc.data ?? [], moves: mv.data ?? [], mutes: mutes.data ?? [] });
}

export async function postAnomalyMute(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as { key?: unknown; muted?: unknown; expect_tenant?: unknown };
  if (body.expect_tenant !== undefined && body.expect_tenant !== auth.tenant_id) {
    res.status(409).json({ error: { code: "tenant_mismatch", message: "This session is on a different company." } });
    return;
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!MUTE_KEY_RE.test(key)) {
    res.status(400).json({ error: { code: "invalid_key", message: "key must be a metric id, read_failed:<source>, or *." } });
    return;
  }
  const muted = body.muted !== false;
  const db = tenantClient(asTenantId(auth.tenant_id));
  const { error } = muted
    ? await db
        .from("metric_alert_mutes")
        .upsert({ mute_key: key, muted_by: auth.user_id }, { onConflict: "tenant_id,mute_key", ignoreDuplicates: true })
    : await db.from("metric_alert_mutes").delete().eq("mute_key", key);
  if (error) {
    res.status(500).json({ error: { code: "mute_failed", message: error.message } });
    return;
  }
  res.json({ ok: true, key, muted });
}
