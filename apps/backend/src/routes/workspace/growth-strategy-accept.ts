
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { applyGrowthStrategy } from "@/services/growth/apply-strategy";

export { renderGtmAnchor, renderNorthStarAnchor } from "@/services/growth/apply-strategy";

export async function workspaceGrowthStrategyApply(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const result = await applyGrowthStrategy(auth.tenant_id, { by: "page", user_id: auth.user_id });
    if (result.skipped === "no_strategy") {
      res.status(404).json({
        error: { code: "no_strategy", message: "There is no written strategy to apply." },
      });
      return;
    }
    res.status(result.applied ? 200 : 500).json({
      accepted: result.applied,
      applied: result.applied,
      wrote: result.wrote,
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.problems.length > 0 ? { problems: result.problems } : {}),
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "apply_failed", message: (e as Error).message },
    });
  }
}

export const workspaceGrowthStrategyAccept = workspaceGrowthStrategyApply;
