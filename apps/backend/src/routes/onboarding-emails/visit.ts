
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ONBOARDING_SRC_RE, stepByNumber } from "@/services/onboarding-emails/steps";

export function onboardingStepFromSrc(src: unknown): number | null {
  if (typeof src !== "string") return null;
  const m = ONBOARDING_SRC_RE.exec(src);
  if (!m) return null;
  const step = Number(m[1]);
  return stepByNumber(step) ? step : null;
}

export async function postOnboardingEmailVisit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const step = onboardingStepFromSrc(((req.body ?? {}) as { src?: unknown }).src);
  if (step !== null && !auth.tenant_overridden) {
    const { error } = await tenantClient(asTenantId(auth.tenant_id))
      .from("onboarding_email_visits")
      .upsert(
        { user_id: auth.user_id, step },
        { onConflict: "tenant_id,user_id,step", ignoreDuplicates: true },
      );
    if (error) console.warn(`[onboarding-emails visit] write failed: ${error.message}`);
  }
  res.status(204).end();
}
