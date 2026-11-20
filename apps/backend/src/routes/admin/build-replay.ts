import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { getStringSettingStrict } from "@/services/settings";
import {
  BUILD_REPLAY_FIXTURES,
  BUILD_REPLAY_SETTING,
  buildReplayAllowed,
} from "@/services/agents/build-replay-config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffBuildReplayGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = String(req.query.tenant_id ?? "");
  if (!UUID_RE.test(tenant_id)) {
    res.status(400).json({ error: { code: "bad_request", message: "tenant_id required" } });
    return;
  }
  try {
    const fixture = await getStringSettingStrict(BUILD_REPLAY_SETTING, tenant_id);
    res.json({ tenant_id, fixture, allowed: buildReplayAllowed(), fixtures: BUILD_REPLAY_FIXTURES });
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}
