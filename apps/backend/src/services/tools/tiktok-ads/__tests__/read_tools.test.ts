import { expect, it, vi } from "vitest";
vi.mock("../propose_changes", () => ({ savedAdvertiser: async () => ({ advertiser_id: "111" }) }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({
  tiktokAdsAccount: async () => ({ tenant_id: "T" }),
  tt: async (_account: unknown, path: string) => ({
    page_info: { total_page: 1 },
    list: path.startsWith("/adgroup/")
      ? [{ campaign_id: "101", adgroup_id: "201", adgroup_name: "Ended group", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_TIME_DONE", budget: 20.01, budget_mode: "BUDGET_MODE_DAY" }]
      : [{ campaign_id: "101", adgroup_id: "201", ad_id: "301", operation_status: "ENABLE", secondary_status: "AD_STATUS_DONE" }],
  }),
}));
import { tiktokAdsListAdGroupsTool } from "../read_tools";
it("retains delivery blockers separately from the group and ad switches", async () => {
  const result = await tiktokAdsListAdGroupsTool.execute({ tenant_id: "T" } as never, { campaign_id: "101" });
  expect(result).toMatchObject({ ad_groups: [{ status: "ACTIVE", secondary_status: "ADGROUP_STATUS_TIME_DONE", budget: 20.01, ads: [{ status: "ACTIVE", secondary_status: "AD_STATUS_DONE" }] }] });
});
