
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { resolveTenantOwnerEmail } from "@/email/sendAuthEmail";

export type AgentEmailRecipient = {
  email: string;
  is_owner: boolean;
  id: string | null;
  label: string | null;
};

export async function resolveAgentEmailRecipients(
  tenant_id: string,
): Promise<AgentEmailRecipient[]> {
  const [ownerEmail, rows] = await Promise.all([
    resolveTenantOwnerEmail(tenant_id),
    tenantClient(asTenantId(tenant_id))
      .from("agent_email_recipients")
      .select("id, email, label")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.warn(
            `[agent-email-recipients] read failed for tenant ${tenant_id}: ${error.message}`,
          );
          return [] as { id: string; email: string; label: string | null }[];
        }
        return (data ?? []) as { id: string; email: string; label: string | null }[];
      }),
  ]);

  const out: AgentEmailRecipient[] = [];
  const seen = new Set<string>();

  if (ownerEmail) {
    out.push({ email: ownerEmail, is_owner: true, id: null, label: "Owner" });
    seen.add(ownerEmail.toLowerCase());
  }
  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email: r.email, is_owner: false, id: r.id, label: r.label });
  }
  return out;
}
