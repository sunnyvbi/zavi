import { resolveTenantOwnerEmailOrThrow } from "@/email/sendAuthEmail";

export async function resolveBulkReplyTo(tenantId: string): Promise<string | null> {
  return (await resolveTenantOwnerEmailOrThrow(tenantId)) ?? null;
}
