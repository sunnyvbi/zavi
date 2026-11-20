
import type { Request, Response } from "express";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { verifyBearer } from "@/services/auth/jwt";
import { serviceClient } from "@/services/supabase";

const Body = z.object({ key: z.string().min(1).max(256) });

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function redeemBetaSecret(req: Request, res: Response): Promise<void> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({
      error: { code: "validation", message: (e as Error).message },
    });
    return;
  }

  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Sign in first." },
    });
    return;
  }

  const secret = process.env.BETA_INVITE_SECRET;
  if (!secret) {
    res.status(503).json({
      error: { code: "invite_unavailable", message: "Invite redemption is not available." },
    });
    return;
  }

  if (!safeEq(body.key, secret)) {
    res.status(400).json({
      error: { code: "invite_invalid", message: "Invalid invite link." },
    });
    return;
  }

  const { error } = await serviceClient()
    .from("profiles")
    .upsert(
      {
        user_id: verified.user_id,
        beta_invited_at: new Date().toISOString(),
      },
      { onConflict: "user_id", ignoreDuplicates: false },
    );

  if (error) {
    console.error(
      `[redeem-secret] upsert failed for ${verified.user_id}: ${error.message}`,
    );
    res.status(500).json({
      error: { code: "stamp_failed", message: "Could not stamp invite. Try again." },
    });
    return;
  }

  res.json({ ok: true });
}
