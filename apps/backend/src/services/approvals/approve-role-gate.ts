
import { tiktokActionRaisesSpend } from "@/services/connectors/tiktok-ads/held-schema";
import { metaActionRaisesSpend } from "@/services/tools/meta-ads/write/_decision-bodies";
import { chatgptActionRaisesSpend } from "@/services/connectors/chatgpt-ads/raises-spend";
import { googleActionRaisesSpend } from "@zavi/shared";

export const OWNER_ONLY_APPROVE_CLASSES: ReadonlySet<string> = new Set([
  "browser.action",
  "dispute-response.final-submit-evidence",
  "composio.moves_money",
  "composio.deletes_data",
  "composio.shopify_write",
  "linkedin_ads.launch_campaign",
]);

export function approveNeedsOwnerOrAdmin(cls: string | null | undefined, body: unknown): boolean {
  if (typeof cls !== "string" || cls.length === 0) return false;
  return (
    OWNER_ONLY_APPROVE_CLASSES.has(cls) ||
    tiktokActionRaisesSpend(cls, body) ||
    metaActionRaisesSpend(cls, body) ||
    googleActionRaisesSpend(cls, body) ||
    chatgptActionRaisesSpend(cls, body)
  );
}
