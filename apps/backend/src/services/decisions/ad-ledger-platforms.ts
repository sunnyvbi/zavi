
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { readTiktokAccountsForBudget } from "@/services/connectors/tiktok-ads/budget-ledger";
import { readPinterestAccountsForBudget } from "@/services/connectors/pinterest-ads/budget-ledger";
import { readSnapchatAccountsForBudget } from "@/services/connectors/snapchat-ads/budget-ledger";
import { readMicrosoftAccountsForBudget } from "@/services/connectors/microsoft-ads/budget-ledger";
import { readAppleAccountsForBudget } from "@/services/connectors/apple-ads/budget-ledger";
import { readSpotifyAccountsForBudget } from "@/services/connectors/spotify-ads/budget-ledger";
import { readLinkedinAccountsForBudget } from "@/services/connectors/linkedin-ads/budget-ledger";

export const LEDGER_ONLY_PLATFORMS = [
  "tiktok",
  "pinterest",
  "snapchat",
  "microsoft",
  "apple",
  "spotify",
  "linkedin",
] as const;
export type LedgerOnlyPlatform = (typeof LEDGER_ONLY_PLATFORMS)[number];

export function isLedgerOnlyPlatform(p: string): p is LedgerOnlyPlatform {
  return (LEDGER_ONLY_PLATFORMS as readonly string[]).includes(p);
}

type Reader = (tenantId: string, start: Date, now: Date) => Promise<AccountRead[]>;

export const LEDGER_ONLY_READERS: ReadonlyArray<{
  platform: LedgerOnlyPlatform;
  slugs: readonly string[];
  name: string;
  object: string;
  read: Reader;
}> = [
  { platform: "tiktok", slugs: ["composio.tiktok_ads", "tiktok_ads"], name: "TikTok Ads", object: "campaign", read: readTiktokAccountsForBudget },
  { platform: "pinterest", slugs: ["pinterest_ads"], name: "Pinterest Ads", object: "ad group", read: readPinterestAccountsForBudget },
  { platform: "snapchat", slugs: ["snapchat_ads"], name: "Snapchat Ads", object: "ad squad", read: readSnapchatAccountsForBudget },
  { platform: "microsoft", slugs: ["microsoft_ads"], name: "Microsoft Ads", object: "campaign", read: readMicrosoftAccountsForBudget },
  { platform: "apple", slugs: ["apple_ads"], name: "Apple Ads", object: "campaign", read: readAppleAccountsForBudget },
  { platform: "spotify", slugs: ["spotify_ads"], name: "Spotify Ads", object: "ad set", read: readSpotifyAccountsForBudget },
  { platform: "linkedin", slugs: ["linkedin_ads"], name: "LinkedIn Ads", object: "campaign", read: readLinkedinAccountsForBudget },
];
