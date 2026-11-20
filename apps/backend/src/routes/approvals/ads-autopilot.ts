
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";

export const adsAutopilotBodySchema = z.object({
  platform: z.enum(["meta_ads", "google_ads", "linkedin_ads"]),
  enabled: z.boolean(),
  max_daily_budget_usd: z.number().positive().nullable().optional(),
});

export type AdsAutopilotRpcResult = { ok?: boolean; reason?: string; max?: number };

export function mapAdsAutopilotResult(result: AdsAutopilotRpcResult): {
  status: number;
  body: unknown;
} {
  if (result.ok === true) return { status: 200, body: { ok: true } };
  switch (result.reason) {
    case "not_owner":
      return {
        status: 403,
        body: { error: { code: "not_owner", message: "only a tenant owner or admin can change ads autopilot" } },
      };
    case "over_self_serve_max":
      return {
        status: 422,
        body: {
          error: {
            code: "over_self_serve_max",
            message: `Max self-serve is $${result.max ?? 500}/day — contact us for higher`,
            max: result.max ?? 500,
          },
        },
      };
    case "bad_platform":
    case "bad_budget":
      return { status: 400, body: { error: { code: "bad_request", message: result.reason } } };
    default:
      return {
        status: 500,
        body: { error: { code: "ads_autopilot_failed", message: result.reason ?? "unknown" } },
      };
  }
}

export async function approvalsAdsAutopilot(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = adsAutopilotBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const b = parsed.data;

  if (b.enabled && (b.max_daily_budget_usd === null || b.max_daily_budget_usd === undefined)) {
    res.status(400).json({
      error: { code: "bad_request", message: "max_daily_budget_usd is required when enabling" },
    });
    return;
  }

  const { data, error } = await serviceClient().rpc("set_tenant_ads_autopilot", {
    p_tenant_id: auth.tenant_id,
    p_actor_user_id: auth.user_id,
    p_platform: b.platform,
    p_enabled: b.enabled,
    p_max_daily_budget_usd: b.max_daily_budget_usd ?? null,
  });

  if (error) {
    res.status(500).json({
      error: { code: "ads_autopilot_failed", message: error.message },
    });
    return;
  }

  const result = (data ?? {}) as AdsAutopilotRpcResult;
  const mapped = mapAdsAutopilotResult(result);
  res.status(mapped.status).json(mapped.body);
}
