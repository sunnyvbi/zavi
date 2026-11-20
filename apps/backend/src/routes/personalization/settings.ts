
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import {
  CUSTOM_INSTRUCTIONS_MAX,
  getTenantPersonalization,
  PersonalizationPatch,
  saveTenantPersonalization,
} from "@/services/personalization/store";

export async function getPersonalization(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const personalization = await getTenantPersonalization(auth.tenant_id);
    res.json({ personalization, limits: { custom_instructions: CUSTOM_INSTRUCTIONS_MAX } });
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}

export async function putPersonalization(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const parsed = PersonalizationPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" } });
    return;
  }
  try {
    const personalization = await saveTenantPersonalization(auth.tenant_id, parsed.data, auth.user_id);
    res.json({ personalization, updated_at: personalization.updated_at });
  } catch (e) {
    res.status(500).json({ error: { code: "write_failed", message: (e as Error).message } });
  }
}
