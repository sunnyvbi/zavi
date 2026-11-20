import { asTenantId, tenantClient } from "@/services/tenant-client";
import { resolveMemberEmail } from "@/email/sendAuthEmail";

export const UNKNOWN_PAUSER = "a teammate";

export type PauserDeps = {
  isMember: (tenant_id: string, user_id: string) => Promise<boolean>;
  emailOf: (user_id: string) => Promise<string | null>;
};

const defaultDeps: PauserDeps = {
  isMember: async (tenant_id, user_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_users")
      .select("user_id")
      .eq("user_id", user_id)
      .maybeSingle<{ user_id: string }>();
    return !error && !!data;
  },
  emailOf: resolveMemberEmail,
};

export async function pauserNames(
  tenant_id: string,
  userIds: Array<string | null | undefined>,
  deps: PauserDeps = defaultDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const uid of new Set(userIds.filter((u): u is string => typeof u === "string" && u.length > 0))) {
    try {
      if (!(await deps.isMember(tenant_id, uid))) {
        out.set(uid, UNKNOWN_PAUSER);
        continue;
      }
      const email = await deps.emailOf(uid);
      const local = email?.split("@")[0]?.trim();
      out.set(uid, local && local.length > 0 ? local : UNKNOWN_PAUSER);
    } catch {
      out.set(uid, UNKNOWN_PAUSER);
    }
  }
  return out;
}
