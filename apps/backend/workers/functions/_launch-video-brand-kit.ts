
import type { serviceClient } from "@/services/supabase";
import type { BrandKit } from "@/services/launch-video/brief-mapper";
import { resolveBrandKit, type ResolvedBrandKit } from "@/services/brand/resolve-brand-kit";

export async function resolveTenantBrandKit(
  tenant_id: string,
  sb: ReturnType<typeof serviceClient>,
): Promise<BrandKit | undefined> {
  let blobKit: BrandKit | undefined;
  try {
    const { data } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    const kits = (data?.blob ?? {})["tenant_brand_kits"];
    if (kits && typeof kits === "object") {
      const kit = (kits as Record<string, unknown>)[tenant_id];
      if (kit && typeof kit === "object") blobKit = kit as BrandKit;
    }
  } catch {
  }

  if (blobKit?.colors?.primary) return blobKit;

  let resolved: ResolvedBrandKit | null = null;
  try {
    resolved = await resolveBrandKit(tenant_id);
  } catch (e) {
    console.warn(`[render-launch-video] brand kit unresolved: ${(e as Error).message}`);
  }

  if (!resolved || resolved.source === "default") return blobKit;

  return {
    ...blobKit,
    colors: {
      primary: resolved.primary,
      accent: resolved.accent ?? resolved.primary,
      ...(resolved.bg ? { bg: resolved.bg } : {}),
    },
  };
}

