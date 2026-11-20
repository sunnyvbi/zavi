
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import { requireClosedBetaGrant } from "@/services/auth/closedBetaGate";
import { checkSelfServeTenantCap } from "@/services/tenants/tenant-create-guard";

export async function getCanAddCompany(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  const beta = await requireClosedBetaGrant(verified.user_id);
  if (!beta.ok) {
    res.json({ allowed: false, code: beta.code });
    return;
  }
  const rejection = await checkSelfServeTenantCap(verified.user_id);
  res.json({ allowed: rejection === null, code: rejection?.code ?? null });
}
