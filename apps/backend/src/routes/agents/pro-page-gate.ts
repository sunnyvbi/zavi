import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { checkAgentTier, planUpgradeErrorBody } from "@/services/agents/entitlement";

export function proPageGate(slug: string) {
  return async function proPageGateMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const d = await checkAgentTier(auth.tenant_id, slug);
      if (!d.allowed) {
        res.status(403).json(planUpgradeErrorBody(slug, d.required_tier));
        return;
      }
    } catch (e) {
      console.error(`[pro-page-gate] tier check failed for ${slug}: ${(e as Error).message}`);
      res.status(503).json({
        error: { code: "plan_check_unavailable", message: "Couldn't check your plan. Please try again." },
      });
      return;
    }
    next();
  };
}
