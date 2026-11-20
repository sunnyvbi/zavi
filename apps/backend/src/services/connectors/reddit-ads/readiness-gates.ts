import { ExpectedToolError } from "@/services/tools/types";
import { ownedAccount } from "./adapter";
import { accountApproved, tracking } from "./readiness";

export async function assertReady(tenantId: string, accountId: string, pixelId: string) {
  const { account, details } = await ownedAccount(tenantId, accountId);
  if (details.currency !== "USD") throw new ExpectedToolError("reddit_ads_currency_unsupported", `Reddit Ads execution currently supports USD; this account uses ${String(details.currency)}.`);
  if (!accountApproved(details)) throw new ExpectedToolError("reddit_ads_account_not_ready", "Resolve account approval or suspension in Reddit Ads Manager.");
  const signal = await tracking(account, accountId, pixelId);
  return { account, details, signal };
}
