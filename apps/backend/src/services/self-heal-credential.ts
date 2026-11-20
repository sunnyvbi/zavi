
import { isPlatformSourceRepo, PLATFORM_SOURCE_REPO } from "./platform-source-repo";

export { isPlatformSourceRepo, PLATFORM_SOURCE_REPO };

export const SELF_HEAL_SOURCE_AGENT = "self-heal-loop";

export function selfHealEnabled(): boolean {
  return process.env.SELF_HEAL_ENABLED === "1";
}

export function selfHealStaffTenantId(): string {
  return (process.env.SELF_HEAL_STAFF_TENANT_ID ?? "").trim();
}

export function isSelfHealPlatformRun(args: {
  tenant_id: string | undefined | null;
  source_agent: string | undefined | null;
  agent_slug?: string | undefined | null;
}): boolean {
  const staff = selfHealStaffTenantId();
  if (!selfHealEnabled()) return false;
  if (staff.length === 0) return false;
  if (args.tenant_id !== staff) return false;
  if (args.source_agent !== SELF_HEAL_SOURCE_AGENT) return false;
  if (args.agent_slug !== undefined && args.agent_slug !== null && args.agent_slug !== "engineer") {
    return false;
  }
  return true;
}
