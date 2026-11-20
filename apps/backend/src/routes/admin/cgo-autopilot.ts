
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { getBoolSettingStrictResolved } from "@/services/settings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffCgoAutopilotGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = String(req.query.tenant_id ?? "");
  if (!UUID_RE.test(tenant_id)) {
    res.status(400).json({ error: { code: "bad_request", message: "tenant_id required" } });
    return;
  }
  try {
    const enabled = await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
    res.json({ tenant_id, enabled });
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}
