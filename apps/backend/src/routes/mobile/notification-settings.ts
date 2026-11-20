
import type { Request, Response } from "express";
import { z } from "zod";

import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const DEFAULTS = {
  agent_replies: true,
  approvals: true,
  daily_brief: false,
} as const;

const patchBody = z
  .object({
    agent_replies: z.boolean().optional(),
    approvals: z.boolean().optional(),
    daily_brief: z.boolean().optional(),
  })
  .strict();

export async function getNotificationSettings(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("notification_settings")
    .select("agent_replies, approvals, daily_brief")
    .eq("tenant_id", auth.tenant_id)
    .eq("user_id", auth.user_id)
    .maybeSingle<{
      agent_replies: boolean;
      approvals: boolean;
      daily_brief: boolean;
    }>();
  if (error) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: error.message } });
    return;
  }

  res.json({
    agent_replies: data?.agent_replies ?? DEFAULTS.agent_replies,
    approvals: data?.approvals ?? DEFAULTS.approvals,
    daily_brief: data?.daily_brief ?? DEFAULTS.daily_brief,
  });
}

export async function patchNotificationSettings(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = patchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("upsert_notification_settings", {
    p_agent_replies: parsed.data.agent_replies ?? null,
    p_approvals: parsed.data.approvals ?? null,
    p_daily_brief: parsed.data.daily_brief ?? null,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "update_failed", message: error.message } });
    return;
  }

  const row = Array.isArray(data) ? data[0] : data;
  res.json({
    agent_replies: row?.agent_replies ?? DEFAULTS.agent_replies,
    approvals: row?.approvals ?? DEFAULTS.approvals,
    daily_brief: row?.daily_brief ?? DEFAULTS.daily_brief,
  });
}
