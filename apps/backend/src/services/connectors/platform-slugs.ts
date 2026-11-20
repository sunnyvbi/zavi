
import { LEDGER_ONLY_READERS } from "@/services/decisions/ad-ledger-platforms";

const CORE_PLATFORM_SLUGS: Record<string, readonly string[]> = {
  meta: ["meta_ads"],
  google: ["google_ads"],
  reddit: ["reddit_ads", "composio.reddit_ads"],
  x: ["x_ads"],
};

export function platformConnectorSlugs(platform: string): readonly string[] {
  return (
    CORE_PLATFORM_SLUGS[platform] ??
    LEDGER_ONLY_READERS.find((r) => r.platform === platform)?.slugs ??
    []
  );
}

export function platformNativeSlug(platform: string): string | null {
  const slugs = platformConnectorSlugs(platform);
  return slugs.find((s) => !s.startsWith("composio.")) ?? slugs[0] ?? null;
}
