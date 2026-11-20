
import { getSetting } from "@/services/settings";

type SandboxGateAgent = {
  slug: string;
  metadata_praxis: { requires_sandbox?: boolean };
};

const SANDBOX_FLAG_DENYLIST = new Set<string>(["operator"]);

export async function resolveEffectiveRequiresSandbox(
  agent: SandboxGateAgent,
  tenant_id: string | null | undefined,
): Promise<boolean> {
  const base = agent.metadata_praxis.requires_sandbox === true;
  if (base) return true;
  if (!tenant_id) return false;
  if (SANDBOX_FLAG_DENYLIST.has(agent.slug)) return false;
  try {
    const raw = await getSetting("sandbox_enabled_agents", tenant_id);
    if (Array.isArray(raw) && (raw.includes("*") || raw.includes(agent.slug))) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export type SandboxResolution = {
  requires_sandbox: boolean;
  lazyEligible: boolean;
};

export async function resolveSandboxMode(
  agent: SandboxGateAgent,
  tenant_id: string | null | undefined,
): Promise<SandboxResolution> {
  const base = agent.metadata_praxis.requires_sandbox === true;
  const requires_sandbox = await resolveEffectiveRequiresSandbox(agent, tenant_id);
  return { requires_sandbox, lazyEligible: requires_sandbox && !base };
}
