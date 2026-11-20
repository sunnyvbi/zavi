
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { scanSpendAllowed, tickPerUserLimit } from "@/services/onboarding/scan";
import {
  MEMORY_REQUESTED_EVENT,
  isTenantMember,
  markMemoryFailed,
  readMemoryRow,
  resetMemoryForRetry,
} from "@/services/onboarding/background-memory";
import { inngest } from "@/../workers/client";

export async function onboardingMemoryRetry(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenantId = auth.tenant_id;

  try {
    if (!(await isTenantMember(tenantId, auth.user_id))) {
      res.status(403).json({ error: { code: "not_member", message: "You are not a member of this workspace." } });
      return;
    }
    const row = await readMemoryRow(tenantId);
    if (!row || row.status !== "failed") {
      res.status(409).json({ error: { code: "not_failed", message: "There is nothing to retry." } });
      return;
    }
    const spend = await scanSpendAllowed();
    if (!spend.ok || !(await tickPerUserLimit(auth.user_id))) {
      res.status(429).json({ error: { code: "retry_limited", message: "Too many retries. Please try again later." } });
      return;
    }
    const attempt = await resetMemoryForRetry(tenantId, row);
    if (attempt === null) {
      res.status(409).json({ error: { code: "not_failed", message: "There is nothing to retry." } });
      return;
    }
    try {
      await inngest.send({ name: MEMORY_REQUESTED_EVENT, data: { tenant_id: tenantId, attempt } });
    } catch (e) {
      await markMemoryFailed(tenantId, `enqueue failed: ${(e as Error).message}`).catch(() => undefined);
      res.status(500).json({ error: { code: "enqueue_failed", message: "Couldn't start the retry. Please try again." } });
      return;
    }
    res.status(202).json({ ok: true, attempt });
  } catch (e) {
    res.status(500).json({ error: { code: "retry_failed", message: (e as Error).message } });
  }
}
