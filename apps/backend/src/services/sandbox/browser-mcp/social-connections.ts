
import { getSecret } from "@/services/secrets/vault";
import { serviceClient } from "@/services/supabase";
import { HOSTILE_ORIGIN_SUFFIXES } from "./engine-policy";

export type SocialPlatform = "instagram" | "linkedin" | "tiktok";

const ORIGIN_SUFFIX_TO_PLATFORM: Readonly<Record<string, SocialPlatform>> = {
  "instagram.com": "instagram",
  "linkedin.com": "linkedin",
  "tiktok.com": "tiktok",
};

export function platformForOrigin(origin?: string): SocialPlatform | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const suffix of HOSTILE_ORIGIN_SUFFIXES) {
    if (host === suffix || host.endsWith("." + suffix)) {
      return ORIGIN_SUFFIX_TO_PLATFORM[suffix] ?? null;
    }
  }
  return null;
}

function usernameKey(p: SocialPlatform, handle: string): string {
  return `social.${p}.${handle}.username`;
}
function passwordKey(p: SocialPlatform, handle: string): string {
  return `social.${p}.${handle}.password`;
}

export interface SocialCredentials {
  username: string;
  password: string;
}

async function ownsConnectedAccount(
  tenant_id: string,
  platform: SocialPlatform,
  handle: string,
  owner_user_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id || !owner_user_id) return false;
  try {
    const { data, error } = await serviceClient()
      .from("social_connected_accounts")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("handle", handle)
      .eq("owner_user_id", owner_user_id)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

export async function getSocialCredentials(
  tenant_id: string,
  platform: SocialPlatform,
  handle: string,
  owner_user_id: string | null | undefined,
): Promise<SocialCredentials | null> {
  if (!(await ownsConnectedAccount(tenant_id, platform, handle, owner_user_id))) {
    return null;
  }
  const username = await getSecret(tenant_id, usernameKey(platform, handle));
  const password = await getSecret(tenant_id, passwordKey(platform, handle));
  if (!username || !password) return null;
  return { username, password };
}

export interface SetSocialConnectionArgs {
  tenant_id: string;
  platform: SocialPlatform;
  handle: string;
  username: string;
  password: string;
  owner_user_id: string;
  anchor_profile_id?: string;
}

export async function setSocialConnection(
  args: SetSocialConnectionArgs,
): Promise<void> {
  const { error } = await serviceClient().rpc("set_social_connection", {
    p_tenant_id: args.tenant_id,
    p_platform: args.platform,
    p_handle: args.handle,
    p_username: args.username,
    p_password: args.password,
    p_owner_user_id: args.owner_user_id,
    p_anchor_profile_id: args.anchor_profile_id ?? null,
  });
  if (error) {
    throw new Error(`set_social_connection failed: ${error.message}`);
  }
}

export interface ConnectedSocialAccount {
  platform: SocialPlatform;
  handle: string;
  anchor_profile_id: string | null;
}

export async function getConnectedSocialAccount(
  tenant_id: string,
  origin: string | undefined,
  owner_user_id: string | null | undefined,
): Promise<ConnectedSocialAccount | null> {
  const platform = platformForOrigin(origin);
  if (!platform || !tenant_id || !owner_user_id) return null;
  try {
    const { data, error } = await serviceClient()
      .from("social_connected_accounts")
      .select("handle, anchor_profile_id")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("owner_user_id", owner_user_id)
      .eq("status", "connected")
      .limit(1)
      .maybeSingle();
    if (error || !data || typeof data.handle !== "string") return null;
    return {
      platform,
      handle: data.handle,
      anchor_profile_id:
        typeof data.anchor_profile_id === "string"
          ? data.anchor_profile_id
          : null,
    };
  } catch {
    return null;
  }
}

export async function markSocialAccountChallenged(
  tenant_id: string,
  platform: SocialPlatform,
  handle: string,
  owner_user_id: string | null | undefined,
): Promise<void> {
  if (!owner_user_id) return;
  try {
    await serviceClient()
      .from("social_connected_accounts")
      .update({ status: "challenged" })
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("handle", handle)
      .eq("owner_user_id", owner_user_id);
  } catch {
  }
}

export async function tenantHasConnectedProfileForOrigin(
  tenant_id: string,
  origin: string | undefined,
  owner_user_id: string | null | undefined,
): Promise<boolean> {
  const platform = platformForOrigin(origin);
  if (!platform || !tenant_id || !owner_user_id) return false;
  try {
    const { data, error } = await serviceClient()
      .from("social_connected_accounts")
      .select("anchor_profile_id")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("owner_user_id", owner_user_id)
      .eq("status", "connected")
      .not("anchor_profile_id", "is", null)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
