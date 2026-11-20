
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting } from "@/services/settings";

export async function gateRaise(
  req: Request,
  res: Response,
): Promise<{ tenant_id: string; user_id: string } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const enabled = await getBoolSetting("raise_room_advisor", auth.tenant_id).catch(
    () => false,
  );
  if (!enabled) {
    res.status(404).json({
      error: {
        code: "not_found",
        message: "raise room advisor not enabled for this tenant",
      },
    });
    return null;
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id };
}
