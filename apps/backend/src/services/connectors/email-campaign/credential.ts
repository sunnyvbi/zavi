
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const composioCredentialSchema = z
  .object({ kind: z.literal("composio"), connected_account_id: z.string().min(1).max(200), auth_config_id: z.string().min(1).max(200) })
  .strict();
export const sendgridCredentialSchema = z.object({ kind: z.literal("sendgrid_key"), key_digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const sealedCredentialSchema = z.discriminatedUnion("kind", [composioCredentialSchema, sendgridCredentialSchema]);
export type SealedCredential = z.infer<typeof sealedCredentialSchema>;

const DIGEST_CONTEXT = "zavi-sendgrid-key-digest:v1\u0000";

export function sendgridKeyDigest(apiKey: string, secret: string | undefined = process.env.SUPABASE_SERVICE_ROLE_KEY): string {
  if (!secret || secret.length < 16) throw new Error("sendgrid key digest secret is not configured");
  return createHmac("sha256", secret).update(DIGEST_CONTEXT + apiKey).digest("hex");
}

export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
