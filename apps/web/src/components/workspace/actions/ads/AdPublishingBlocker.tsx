import { CircleAlert } from "lucide-react";
import { AD_BILLING_URL, AD_BUDGET_URL, AD_CONNECTIONS_URL } from "@/lib/workspace/tabUrl";
import { cardAccountId, type ActionItem, type PlatformSpec } from "../types";
import { useChannelAccount } from "../campaignLinks";

export function AdPublishingBlocker({ action, platform, connectionBlocker }: { action: ActionItem; platform?: PlatformSpec; connectionBlocker?: { message: string } | null }) {
  const account = useChannelAccount(action.channel_slug);
  const failure = action.exec_status === "failed" && action.exec_bucket === "needs_founder" ? action.exec_fix_text : null;
  if (!failure && !connectionBlocker) return null;
  const fix = action.exec_fix;
  const href = connectionBlocker || fix === "reconnect" || fix === "permission" || fix === "page_grant" ? AD_CONNECTIONS_URL :
    fix === "ad_budget" ? AD_BUDGET_URL : fix === "credits" || fix === "plan" ? AD_BILLING_URL :
    fix === "billing" || fix === "page" || fix === "audience_terms" ? (platform?.taskLink?.(fix === "billing" ? "billing" : null, cardAccountId(action) ?? account) ?? platform?.manageUrl) : undefined;
  return <div role="status" className="mt-4 flex flex-wrap items-start gap-2 text-sm text-danger" data-testid="ad-publishing-blocker">
    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
    <span>Can’t publish yet: {connectionBlocker?.message ?? failure}.</span>
    {href && <a href={href} className="font-semibold text-ink underline underline-offset-4">Fix it</a>}
  </div>;
}
