import { chatgptAdsGet } from "./http";
import { ExpectedToolError } from "@/services/tools/types";
function host(value: unknown) {
  try {
    return typeof value === "string"
      ? new URL(value).hostname.toLowerCase().replace(/^www\./, "")
      : null;
  } catch {
    return null;
  }
}
export function servingReady(account: Record<string, any>): boolean {
  const approvedWebsite = host(process.env.CHATGPT_ADS_ADVERTISER_WEBSITE);
  return (
    process.env.CHATGPT_ADS_SERVING_APPROVED === "true" &&
    account.status === "active" &&
    account.review?.status === "approved" &&
    !!approvedWebsite &&
    host(account.url) === approvedWebsite
  );
}
export async function assertServingReady(
  key: string,
  fundingSource: "wallet" | "provider" = "wallet",
) {
  const account = await chatgptAdsGet<Record<string, any>>(key, "/ad_account");
  if (
    !(fundingSource === "provider"
      ? account.status === "active" && account.review?.status === "approved"
      : servingReady(account))
  ) {
    throw new ExpectedToolError(
      "ads_launch_pending",
      "Zavi is completing launch setup. You can save paused campaigns; activation is not available yet.",
    );
  }
}
