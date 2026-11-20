import {
  listXAdAccounts,
  listXCampaignRows,
  listXFundingInstruments,
  xAdsTenantToken,
  xCampaignStats,
} from "@/services/connectors/x-ads/client";
import {
  compactMetrics,
  paidChannel,
  PAID_LABELS,
  type PaidChannelEvidence,
} from "./cgo-evidence";

export async function readXAdsEvidence(
  tenantId: string,
  now: Date,
): Promise<PaidChannelEvidence> {
  const accounts = await listXAdAccounts(tenantId);
  if (accounts.length !== 1)
    return {
      channel_slug: "x_ads",
      status: "could not read",
      reason: accounts.length
        ? "Multiple accessible X Ads accounts; select the workspace advertiser before reading performance."
        : "No accessible X Ads account.",
    };
  const token = await xAdsTenantToken(tenantId);
  const account = accounts[0];
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      86400000,
  );
  const start = new Date(end.getTime() - 6 * 86400000);
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const campaigns = await listXCampaignRows(token, account.id);
  const funding = await listXFundingInstruments(token, account.id);
  const stats = await xCampaignStats(
    token,
    account.id,
    campaigns.map((c) => c.campaign_id),
    day(start),
    day(end),
  );
  return {
    ...paidChannel(
      "x_ads",
      campaigns
        .filter((c) => c.status !== "DELETED")
        .map((c) => {
          const row = stats.get(c.campaign_id);
          return {
            id: c.campaign_id,
            name: c.name.slice(0, 80),
            objective: null,
            label: PAID_LABELS.trackingUnknown,
            ad_sets: [],
            reported: {
              metrics: compactMetrics(
                row
                  ? Object.fromEntries(
                      Object.entries(row).filter(
                        ([key]) =>
                          !stats.missing
                            .get(c.campaign_id)
                            ?.has(key as keyof typeof row) &&
                          (key !== "conversions" || stats.conversionsRead),
                      ),
                    )
                  : {},
              ),
              currency:
                c.currency ??
                funding.find((f) => f.id === c.funding_instrument_id)
                  ?.currency ??
                null,
              status: c.status,
              period_confirmed: true,
            },
          };
        }),
    ),
    source: "X Ads campaign analytics",
    as_of: now.toISOString(),
    reporting_period: `${day(start)} through ${day(end)} (complete UTC days)`,
    reason:
      "ALL_ON_TWITTER placement only. Conversion health unverified; unavailable metrics are unknown. Attribution and billing can change after reporting.",
  };
}
