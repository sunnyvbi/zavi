import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
const Claims = z
  .object({
    email_hash: z.string().regex(/^[a-f0-9]{64}$/),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .refine((s) => s !== "XX"),
    city: z
      .string()
      .max(120)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .nullable(),
    issued_at: z.string().datetime(),
    nonce: z.string().uuid(),
  })
  .strict();
export function verifySignupLocationTicket(
  payload: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (
    secret.length < 32 ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    payload.length > 2000
  )
    return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  try {
    const c = Claims.parse(JSON.parse(payload));
    const age = now - Date.parse(c.issued_at);
    return age >= -5000 && age <= 60000 ? c : null;
  } catch {
    return null;
  }
}
