
import { isChannelLocked, isChannelLockedStrict } from "@/services/channels/lock";
import { isGoogleAdsWriteEnabled } from "@/services/tools/google-ads/write/_flag-check";
import { isLinkedInAdsWriteEnabled } from "@/services/tools/linkedin-ads/write/_flag-check";
import { isMetaAdsWriteEnabled } from "@/services/tools/meta-ads/write/_flag-check";
import { globalClient } from "@/services/tenant-client";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

export async function isCreatorHireEnabled(): Promise<boolean> {
  if (!CREATOR_MARKETPLACE_ENABLED) return false;
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
  if (error) throw new Error(`system_config read failed: ${error.message}`);
  return ((data?.blob ?? {}) as Record<string, unknown>).creator_hires_enabled === true;
}

const PLATFORMS: Record<string, { enabled: () => Promise<boolean>; label: string }> = {
  chatgpt_ads: { enabled: async () => !(await isChannelLocked("chatgpt_ads")), label: "ChatGPT Ads" },
  google_ads: { enabled: isGoogleAdsWriteEnabled, label: "Google Ads" },
  linkedin_ads: { enabled: isLinkedInAdsWriteEnabled, label: "LinkedIn Ads" },
  meta_ads: { enabled: isMetaAdsWriteEnabled, label: "Meta Ads" },
  generated_video: { enabled: async () => !(await isChannelLockedStrict("generated_video")), label: "AI UGC Videos" },
  creator: { enabled: isCreatorHireEnabled, label: "Creator hire" },
  email_campaign: { enabled: async () => !(await isChannelLockedStrict("email_marketing")), label: "Mailchimp, Klaviyo or SendGrid" },
  seo: { enabled: async () => !(await isChannelLockedStrict("seo")), label: "GitHub" },
  geo: { enabled: async () => !(await isChannelLockedStrict("geo")), label: "GitHub" },
};

const STOP_SPEND_CLASSES = new Set(["linkedin_ads.set_status"]);

export function execPlatform(execClass: string): string {
  return execClass.split(".")[0] ?? "";
}

export function execPlatformKeys(): string[] {
  return Object.keys(PLATFORMS);
}

export function execPlatformLabel(execClass: string): string {
  return PLATFORMS[execPlatform(execClass)]?.label ?? "These";
}

export async function platformWriteEnabled(execClass: string): Promise<boolean> {
  if (STOP_SPEND_CLASSES.has(execClass)) return true;
  const platform = PLATFORMS[execPlatform(execClass)];
  if (!platform) return true;
  try {
    return await platform.enabled();
  } catch {
    return false;
  }
}
