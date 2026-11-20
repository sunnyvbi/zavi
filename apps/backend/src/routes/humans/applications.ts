import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import {
  applyToBrief,
  MAX_APPLICATION_NOTE_LEN,
  realApplyDeps,
  type ApplyDeps,
  type ApplyRefusal,
} from "@/services/creators/brief-applications";

const Body = z.object({
  brief_kind: z.literal("creative").default("creative"),
  brief_id: z.string().uuid(),
  pitch: z.string().trim().min(1).max(MAX_APPLICATION_NOTE_LEN).optional(),
  quoted_rate_usd: z.number().nonnegative().max(1_000_000).optional(),
});

const STATUS_BY_CODE: Record<ApplyRefusal, number> = {
  not_a_creator: 403,
  not_approved: 403,
  affiliate_only: 403,
  payout_country_unsupported: 403,
  lane_mismatch: 403,
  brief_not_found: 404,
  brief_closed: 409,
  cap_reached: 409,
  already_applied: 409,
  invalid_quote: 400,
  quote_below_minimum: 400,
};

export function makePostHumanApplication(deps: ApplyDeps) {
  return async function postHumanApplication(req: Request, res: Response): Promise<void> {
    const verified = await verifyBearer(req);
    if (!verified) {
      res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
      return;
    }

    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" },
      });
      return;
    }

    const result = await applyToBrief(
      {
        auth_user_id: verified.user_id,
        brief_id: parsed.data.brief_id,
        quoted_rate_usd: parsed.data.quoted_rate_usd ?? 0,
        note: parsed.data.pitch ?? null,
      },
      deps,
    );

    if (!result.ok) {
      res.status(STATUS_BY_CODE[result.code]).json({
        error: { code: result.code, message: result.message },
      });
      return;
    }

    res.json({ ok: true, application_id: result.application_id, status: "applied" });
  };
}

export const postHumanApplication = makePostHumanApplication(realApplyDeps);
