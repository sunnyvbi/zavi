
import { staffCrossTenantClient } from "@/services/tenant-client";
import { systemSender } from "./system-identity";

export type SendingLane = "tenant_domain" | "shared_agent_domain" | "system_auth_domain";

export interface SendingIdentity {
  from: string;
  name: string | null;
  lane: SendingLane;
}

interface SendingDomainRow {
  domain: string;
  from_address: string | null;
  from_name: string | null;
  verification_status: string;
  provider_domain_id: string | null;
}

export async function resolveAgentSendingIdentity(tenant_id: string): Promise<SendingIdentity> {
  const tenantDomain = await readVerifiedDomain(tenant_id);
  if (tenantDomain) {
    const from = tenantDomain.from_address ?? `hello@${tenantDomain.domain}`;
    return { from, name: tenantDomain.from_name, lane: "tenant_domain" };
  }

  const agentFrom = process.env.AGENT_EMAIL_FROM?.trim();
  if (agentFrom) {
    return {
      from: agentFrom,
      name: process.env.AGENT_EMAIL_FROM_NAME?.trim() || null,
      lane: "shared_agent_domain",
    };
  }

  const system = systemSender();
  console.warn(
    "[sending-identity] agent mail is falling back to the AUTH domain " +
      `(${system.email}) — a spam complaint on agent output will now degrade ` +
      "OTP/password-reset deliverability for every tenant. Set AGENT_EMAIL_FROM to " +
      "split the reputation.",
  );
  return {
    from: system.email,
    name: system.name,
    lane: "system_auth_domain",
  };
}

async function readVerifiedDomain(tenant_id: string): Promise<SendingDomainRow | null> {
  try {
    const { data, error } = await staffCrossTenantClient(
      "email deliverability: resolve a tenant's own verified sending domain",
    )
      .from("tenant_sending_domain")
      .select("domain, from_address, from_name, verification_status, provider_domain_id")
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as SendingDomainRow;
    if (row.verification_status !== "verified") return null;
    if (!row.domain?.trim()) return null;
    if (!row.provider_domain_id) return null;

    return row;
  } catch {
    return null;
  }
}
