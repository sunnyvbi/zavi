import { googleActionRaisesSpend } from "@zavi/shared";
import { redditActionNeedsAdmin } from "@/services/connectors/reddit-ads/schema";
import { xActionRaisesSpend } from "@/services/connectors/x-ads/schema";
import { tiktokActionRaisesSpend } from "@/services/connectors/tiktok-ads/held-schema";
import { metaActionRaisesSpend } from "@/services/tools/meta-ads/write/_decision-bodies";
import { chatgptActionRaisesSpend } from "@/services/connectors/chatgpt-ads/raises-spend";
import { isPageCopyPayload } from "./seo-open-pr";
import { linkedinActionRaisesSpend, linkedinArchiveNeedsAdmin, LINKEDIN_ARCHIVE_CLASS } from "@/services/tools/linkedin-ads/_change-bodies";

const LINKEDIN_OWNER_ONLY: ReadonlySet<string> = new Set([
  "linkedin_ads.create_campaign_bundle",
  "linkedin_ads.launch_campaign",
]);

export function channelActionRaisesSpend(execClass: string | null | undefined, payload: unknown): boolean {
  const ec = execClass ?? "";
  if (!ec) return false;
  return (
    LINKEDIN_OWNER_ONLY.has(ec) ||
    (ec.startsWith("linkedin_ads.") && linkedinActionRaisesSpend(ec, payload)) ||
    redditActionNeedsAdmin(ec, payload) ||
    (ec.startsWith("x_ads.") && xActionRaisesSpend(ec, payload)) ||
    tiktokActionRaisesSpend(ec, payload) ||
    (ec.startsWith("meta_ads.") && metaActionRaisesSpend(ec, payload)) ||
    chatgptActionRaisesSpend(ec, payload) ||
    googleActionRaisesSpend(ec, payload)
  );
}

export function channelActionAdminOnly(execClass: string | null | undefined, payload: unknown): boolean {
  if (execClass === LINKEDIN_ARCHIVE_CLASS) return linkedinArchiveNeedsAdmin(payload);
  return execClass === "seo.create_pr.v1" && isPageCopyPayload(payload);
}

export function channelApproveNeedsAdmin(execClass: string | null | undefined, payload: unknown): boolean {
  return (execClass ?? "").startsWith("creator.") || channelActionAdminOnly(execClass, payload) || channelActionRaisesSpend(execClass, payload);
}

export function channelApproveForbiddenMessage(execClass: string): string {
  if (execClass.startsWith("creator.")) return "Only a workspace owner or admin can approve a creator hire.";
  if (execClass === "seo.create_pr.v1") return "Only a workspace owner or admin can approve this page change.";
  if (execClass === "linkedin_ads.launch_campaign") return "Only a workspace owner or admin can launch a LinkedIn campaign. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.resume_campaign") return "Only a workspace owner or admin can restart a LinkedIn campaign. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.update_campaign_budget") return "Only a workspace owner or admin can raise a LinkedIn budget. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.update_targeting") return "Only a workspace owner or admin can change where a LinkedIn campaign shows. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.update_campaign") return "Only a workspace owner or admin can approve a LinkedIn campaign edit that can raise spend. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.update_campaign_group") return "Only a workspace owner or admin can approve a LinkedIn campaign group edit that can raise spend. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.archive") return "Only a workspace owner or admin can delete something in LinkedIn Ads. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.set_ad_status") return "Only a workspace owner or admin can turn a LinkedIn ad on. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.create_ad" || execClass === "linkedin_ads.swap_ad") return "Only a workspace owner or admin can switch a new LinkedIn ad on. Ask one of them to approve it.";
  if (execClass === "linkedin_ads.create_campaign" || execClass === "linkedin_ads.duplicate") return "Only a workspace owner or admin can create a LinkedIn campaign. Ask one of them to approve it.";
  return "Only a workspace owner or admin can approve this campaign.";
}
