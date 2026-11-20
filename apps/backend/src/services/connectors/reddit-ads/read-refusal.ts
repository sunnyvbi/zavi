import { ExpectedToolError } from "@/services/tools/types";

export function permanentReadRefusal(e: unknown): string | null {
  if (e instanceof Error && e.name === "ZodError") return "The object id in this proposal is not a valid Reddit id.";
  if (!(e instanceof ExpectedToolError)) return null;
  const status = typeof e.meta?.status === "number" ? e.meta.status : null;
  if (e.code === "reddit_ads_not_connected") return "Reddit Ads is not connected for this workspace. Connect it from the Reddit Ads channel page.";
  if (e.code === "reddit_ads_account_not_owned") return "The ad account in this proposal is not reachable through this workspace's Reddit connection.";
  if (e.code === "reddit_ads_object_not_owned" || e.code === "reddit_ads_relationship_mismatch") return "This object is not in the selected Reddit ad account.";
  if (e.code === "reddit_ads_permission_denied") return "Reddit refused Zavi permission to read this object. Check the connected Reddit user's role on this ad account.";
  if (e.code === "reddit_ads_token_revoked") return "Reddit Ads stopped accepting Zavi's access. Reconnect it from the Reddit Ads channel page.";
  if (status === 404 || status === 410) return "Reddit has no such object in this ad account; it may have been deleted.";
  if (e.code === "reddit_ads_invalid_request") return "Reddit rejected the read of this object as invalid; check the object id.";
  return null;
}
