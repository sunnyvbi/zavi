
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export async function isRenderLaunchVideoEnabled(
  tenant_id: string,
  sb?: Sb,
): Promise<boolean> {
  if (!tenant_id) return false;
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const masterOn = blob.render_launch_video_enabled === true || blob.render_video_enabled === true;
    if (!masterOn) return false;
    if (blob.render_launch_video_all === true || blob.render_video_all === true) return true;
    const legacyTenants = Array.isArray(blob.render_launch_video_tenants) ? blob.render_launch_video_tenants : [];
    const aliasTenants = Array.isArray(blob.render_video_tenants) ? blob.render_video_tenants : [];
    return legacyTenants.includes(tenant_id) || aliasTenants.includes(tenant_id);
  } catch {
    return false;
  }
}

export async function isGenerativeVideoEnabled(tenant_id: string, sb?: Sb): Promise<boolean> {
  if (!tenant_id) return false;
  if ((process.env.GENERATIVE_VIDEO_ENABLED || "").trim() === "0") return false;
  try {
    const client = sb ?? serviceClient();
    const { data } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    if (blob.generative_video_disabled === true) return false;
    const disabledTenants = Array.isArray(blob.generative_video_disabled_tenants)
      ? blob.generative_video_disabled_tenants
      : [];
    if (disabledTenants.includes(tenant_id)) return false;
    return true;
  } catch {
    return true;
  }
}
