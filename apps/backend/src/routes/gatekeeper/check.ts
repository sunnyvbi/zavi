
import type { Request, Response } from "express";
import { readBearerToken, verifyBearer } from "@/services/auth/jwt";
import { FLAG_NAME_RE, isFeatureEnabled } from "@/services/gatekeeper";

export async function gatekeeperCheck(req: Request, res: Response): Promise<void> {
  const name = String(req.params.name ?? "");
  if (!FLAG_NAME_RE.test(name)) {
    res.set("Cache-Control", "private, no-store");
    res.json({ name, enabled: false });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Authorization");
  const verified = await verifyBearer(req);
  if (!verified && readBearerToken(req)) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Invalid or expired Bearer token." } });
    return;
  }
  const enabled = await isFeatureEnabled(name, verified?.user_id ?? null, { autoRegister: false });
  res.json({ name, enabled });
}
