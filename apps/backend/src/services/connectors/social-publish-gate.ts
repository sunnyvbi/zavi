
import type { SupabaseClient } from "@supabase/supabase-js";

export type SocialPublishGate =
  | { open: true; via: "config" | "local_override" }
  | { open: false; error?: string };

export function localOverrideAllows(tenantId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const list = (env.SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(tenantId);
}

export async function socialPublishGate(
  sb: Pick<SupabaseClient, "rpc">,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SocialPublishGate> {
  const { data, error } = await sb.rpc("_social_publish_enabled");
  if (error) return { open: false, error: error.message };
  if (data === true) return { open: true, via: "config" };
  if (localOverrideAllows(tenantId, env)) {
    console.warn(`social-publish: LOCAL OVERRIDE open for tenant ${tenantId} (NODE_ENV=${env.NODE_ENV ?? "unset"})`);
    return { open: true, via: "local_override" };
  }
  if (env.SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS) {
    console.warn(
      `social-publish: rail closed for tenant ${tenantId} — override list set but ` +
        (env.NODE_ENV === "production" ? "NODE_ENV=production (override never applies in prod)" : "tenant not in SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS"),
    );
  }
  return { open: false };
}
