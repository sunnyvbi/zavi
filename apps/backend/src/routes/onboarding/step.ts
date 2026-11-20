
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { logOnboardingStep, ONBOARDING_STEP_STATUSES } from "./step-events";

const Body = z.object({
  step: z.string().trim().min(1).max(80),
  status: z.enum(ONBOARDING_STEP_STATUSES as unknown as [string, ...string[]]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function onboardingStep(req: Request, res: Response): Promise<void> {
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: z.prettifyError(parsed.error) } });
    return;
  }

  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Sign in via /login first." },
    });
    return;
  }

  await logOnboardingStep({
    tenantId: null,
    userId: verified.user_id,
    step: parsed.data.step,
    status: parsed.data.status as
      | "entered"
      | "completed"
      | "skipped"
      | "abandoned"
      | undefined,
    meta: parsed.data.meta,
  });

  res.json({ ok: true });
}
