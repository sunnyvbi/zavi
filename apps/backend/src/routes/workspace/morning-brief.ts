
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { track } from "@/services/analytics/mixpanel";
import { assembleMorningBrief } from "../../services/workspace/morning-brief-assembler";

export type {
  MorningBriefResponse,
  ActivityItem,
  ActivityKind,
} from "../../services/workspace/morning-brief-assembler";

export async function workspaceMorningBrief(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  track("daily_brief_opened", { tenant_id: auth.tenant_id, user_id: auth.user_id });
  const supabase = serverClientFromBearer(auth.access_token);
  const brief = await assembleMorningBrief(supabase, auth.tenant_id, new Date());

  const { _sanitize_violations: _omit, ...customerBrief } = brief;
  res.json(customerBrief);
}
