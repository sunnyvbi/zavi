import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { signupLocationClient } from "@/services/tenant-client";
const Body = z
  .object({
    user_id: z.string().uuid(),
    payload: z.string().max(2000),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export { verifySignupLocationTicket } from "@/services/account/signup-location-ticket";
import { verifySignupLocationTicket } from "@/services/account/signup-location-ticket";
export async function signupLocation(
  req: Request,
  res: Response,
): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store");
  const body = Body.safeParse(req.body);
  const secret = process.env.SIGNUP_LOCATION_SIGNING_SECRET ?? "";
  const claims = body.success
    ? verifySignupLocationTicket(body.data.payload, body.data.signature, secret)
    : null;
  if (!body.success || !claims) {
    res.status(400).json({ error: { code: "invalid_location_ticket" } });
    return;
  }
  const db = signupLocationClient(
    "signup-location: signed CloudFront ticket bound to a newly created auth identity",
  );
  const { data, error } = await db.auth.admin.getUserById(body.data.user_id);
  if (error || !data.user) {
    res.status(400).json({ error: { code: "invalid_location_ticket" } });
    return;
  }
  const user = data.user;
  const emailHash = createHash("sha256")
    .update((user.email ?? "").trim().toLowerCase())
    .digest("hex");
  const metadataMatches =
    user.user_metadata?.growth_signup_location_ticket === body.data.signature;
  const verified = metadataMatches ? null : await verifyBearer(req);
  const created = Date.parse(user.created_at),
    issued = Date.parse(claims.issued_at);
  if (
    emailHash !== claims.email_hash ||
    (!metadataMatches && verified?.user_id !== user.id) ||
    Math.abs(created - issued) > 60000 ||
    Date.now() - created > 60000
  ) {
    res.status(400).json({ error: { code: "invalid_location_ticket" } });
    return;
  }
  const saved = await db.rpc("record_admin_growth_signup_location", {
    p_user_id: user.id,
    p_country: claims.country,
    p_city: claims.city,
    p_issued_at: claims.issued_at,
  });
  if (saved.error) {
    res.status(503).json({ error: { code: "location_unavailable" } });
    return;
  }
  res.status(204).end();
}
