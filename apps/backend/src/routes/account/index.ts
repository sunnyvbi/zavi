
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { verifyBearer } from "@/services/auth/jwt";
import {
  AccountDeletionError,
  softDeleteAccount,
  type DeletionSource,
} from "@/services/account/delete-account";

const Body = z.object({
  source: z.enum(["mobile", "web", "api"]).optional(),
});

export const accountDeleteLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `account-delete:${req.ip ?? "?"}`,
  handler: (_req: Request, res: Response) =>
    res.status(429).json({
      error: { code: "rate_limited", message: "Too many requests. Try again in a few minutes." },
    }),
});

export async function accountDelete(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Missing or invalid Bearer token." },
    });
    return;
  }

  const parsed = Body.safeParse(req.body ?? {});
  const source: DeletionSource = parsed.success ? (parsed.data.source ?? "api") : "api";

  try {
    const result = await softDeleteAccount({
      user_id: verified.user_id,
      access_token: verified.access_token,
      session_id: verified.session_id ?? null,
      source,
    });
    res.status(200).json(result);
  } catch (e) {
    if (e instanceof AccountDeletionError) {
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    console.error(`[account.delete] unexpected failure: ${(e as Error)?.message ?? e}`);
    res.status(500).json({
      error: {
        code: "internal",
        message: "Couldn't delete your account. Please try again, or email support@zaviagent.com.",
      },
    });
  }
}
