
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { checkScanGuards, normalizeWebsiteHost } from "@/services/onboarding/scan";
import { createScan, getScanPublic, markScanFailed } from "@/services/onboarding/scan-store";
import { inngest } from "@/../workers/client";

export const ONBOARDING_SCAN_REQUESTED = "onboarding/scan.requested" as const;

const Body = z.object({ website: z.string().min(1).max(2048) });

export async function onboardingScanCreate(req: Request, res: Response): Promise<void> {
  const parsed = Body.safeParse(req.body);
  const host = parsed.success ? normalizeWebsiteHost(parsed.data.website) : null;
  if (!host) {
    res.status(400).json({ error: { code: "validation", message: "Enter a valid website." } });
    return;
  }

  const verified = await verifyBearer(req).catch(() => null);
  const userId = verified?.user_id ?? null;

  const guard = await checkScanGuards(req, userId);
  if (!guard.ok) {
    res.json({ scan_id: null, reason: guard.reason });
    return;
  }

  let scanId: string;
  try {
    scanId = await createScan(host);
  } catch (e) {
    console.warn(`[onboarding/scan] create failed: ${(e as Error).message}`);
    res.json({ scan_id: null });
    return;
  }

  try {
    await inngest.send({ name: ONBOARDING_SCAN_REQUESTED, data: { scan_id: scanId } });
  } catch (e) {
    console.warn(`[onboarding/scan] enqueue failed for ${scanId}: ${(e as Error).message}`);
    await markScanFailed(scanId).catch(() => undefined);
    res.json({ scan_id: null });
    return;
  }

  res.json({ scan_id: scanId });
}

export async function onboardingScanGet(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  let scan: Awaited<ReturnType<typeof getScanPublic>>;
  try {
    scan = await getScanPublic(id);
  } catch {
    res.status(500).json({ error: { code: "scan_read_failed", message: "Could not read the scan." } });
    return;
  }
  if (!scan) {
    res.status(404).json({ error: { code: "not_found", message: "Scan not found." } });
    return;
  }
  res.json({ status: scan.status, host: scan.host });
}
