
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export const TEST_TENANT_EMAIL_DOMAINS = [
  "thepraxis.ai",
  "example.com",
  "example-praxis-qa.test",
  "mailinator.com",
  "yopmail.com",
] as const;

export function isTestTenantEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return (TEST_TENANT_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

export type TenantKindAudit =
  | "real_owner"
  | "ok"
  | "mismatch"
  | "error";

export async function auditTenantKind(
  tenantId: string,
  userId: string,
  ownerEmail: string | null | undefined,
): Promise<TenantKindAudit> {
  try {
    const sb = serviceClient();
    let email: string | null | undefined = ownerEmail;
    if (!email) {
      const { data, error } = await sb.auth.admin.getUserById(userId);
      if (error) {
        await report("error", tenantId, "tenant_kind.audit_lookup_failed", error.message);
        return "error";
      }
      email = data?.user?.email;
    }
    if (!isTestTenantEmail(email)) return "real_owner";

    const { data: row, error } = await sb
      .from("tenants")
      .select("kind")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) {
      await report("error", tenantId, "tenant_kind.audit_read_failed", error.message);
      return "error";
    }
    const kind = (row as { kind?: string } | null)?.kind ?? null;
    if (kind === "test") return "ok";

    await report(
      "mismatch",
      tenantId,
      "tenant_kind.test_owner_landed_real",
      `owner is on a Praxis test domain but tenants.kind=${kind ?? "null"}; expected 'test'. ` +
        "Check is_test_tenant_email() parity and that this tenant was created through an activation RPC.",
      { kind },
    );
    return "mismatch";
  } catch (e) {
    console.error(`[classify-test-tenant] audit threw for tenant ${tenantId}: ${(e as Error).message}`);
    return "error";
  }
}

async function report(
  what: "error" | "mismatch",
  tenantId: string,
  code: string,
  message: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  console.error(`[classify-test-tenant] ${what} for tenant ${tenantId}: ${message}`);
  await logEvent({ level: "error", source: "tenants.classify", code, message, tenant_id: tenantId, meta });
}
