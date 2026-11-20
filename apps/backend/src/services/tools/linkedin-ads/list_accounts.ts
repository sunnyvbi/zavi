
import { z } from "zod";
import { listLinkedInAdAccounts } from "@/services/connectors/linkedin-ads/client";
import { ownLinkedinAccounts } from "@/services/connectors/linkedin-ads/own-accounts";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { linkedinWalletGroups, walletAdAccount } from "./_wallet";

const inputSchema = z.object({});

const PLAIN_STATUS: Record<string, string> = {
  ACTIVE: "open",
  DRAFT: "not set up yet",
  CANCELED: "closed",
  PENDING_DELETION: "being deleted",
  REMOVED: "deleted",
};

export function plainAccountStatus(status: string | null): string | null {
  if (!status) return null;
  return PLAIN_STATUS[status.toUpperCase()] ?? status.toLowerCase().replace(/_/g, " ");
}

export const linkedinAdsListAccountsTool: ToolSpec = {
  name: "linkedin_ads_list_accounts",
  effect: "read",
  description:
    "List the LinkedIn ad accounts this workspace uses (name, id, currency, status as a plain word like open or closed), " +
    "including the Zavi ads wallet account (funding zavi_wallet) whose campaigns Zavi runs for this workspace. " +
    "Read-only. Call this first — the campaign tool requires an account_id from here. " +
    "Throws linkedin_ads_not_connected if LinkedIn Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const wallet = (await linkedinWalletGroups(ctx.tenant_id)).map(walletAdAccount);
    const listed = await listLinkedInAdAccounts(ctx.tenant_id).catch((e: unknown) => {
      if (wallet.length && e instanceof ExpectedToolError && e.code === "linkedin_ads_not_connected") return [];
      throw e;
    });
    const walletIds = new Set(wallet.map((a) => a.id));
    const own = (listed.length > 0 ? await ownLinkedinAccounts(ctx.tenant_id, listed) : []).filter((a) => !walletIds.has(a.id));
    const accounts = [
      ...own.map((a) => ({ name: a.name, id: a.id, currency: a.currency, status: plainAccountStatus(a.status), funding: "own" as const })),
      ...wallet.map((a) => ({ name: a.name, id: a.id, currency: a.currency, status: null, funding: "zavi_wallet" as const })),
    ];
    return {
      count: accounts.length,
      accounts,
      note:
        accounts.length > 0
          ? undefined
          : listed.length > 0
            ? "No ad account is in use in this workspace yet. The founder chooses one in Ad account and shared wallet, or when they review a new campaign."
            : "The connection is live but no ad account is visible to it. Access is granted per account by the advertiser's own admin.",
    };
  },
};
