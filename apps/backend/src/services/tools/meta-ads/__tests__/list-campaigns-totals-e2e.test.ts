
import { describe, it, expect, vi, beforeEach } from "vitest";

const fbGet = vi.fn();
const metaAdsCreds = vi.fn(async () => ({
  access_token: "test-token",
  ad_account_id: "act_1500492811682727",
}));

vi.mock("../_client", async () => {
  const actual = await vi.importActual<typeof import("../_client")>("../_client");
  return { ...actual, fbGet: (...a: unknown[]) => fbGet(...a), metaAdsCreds: () => metaAdsCreds() };
});

import { metaListCampaignsTool } from "../list_campaigns";
import {
  smartTruncateToolResult,
  toolResultCapBytes,
} from "@/services/agents/smart-truncate";

function insightRows(count = 21) {
  return Array.from({ length: count }, (_, i) => ({
    campaign_id: `12026038987883${1000 + i}`,
    campaign_name: `Campaign ${i} — Labor Day Promo`,
    spend: "51.60",
    impressions: "2152",
    clicks: "130",
    ctr: "6.04",
    cpc: "0.40",
    cpm: "23.98",
    reach: "1827",
    frequency: "1.18",
    actions: [
      { action_type: "purchase", value: "3" },
      { action_type: "lead", value: "4" },
    ],
    action_values: [{ action_type: "purchase", value: "69.70" }],
  }));
}

describe("meta_ads__list_campaigns emits account totals that survive the cap", () => {
  beforeEach(() => {
    fbGet.mockReset();
    fbGet.mockImplementation(async (_tenant: string, path: string) => {
      if (path.endsWith("/insights")) return { data: insightRows() };
      return { data: [] };
    });
  });

  it("returns totals over ALL rows, and they survive this tool's real cap", async () => {
    const out = (await metaListCampaignsTool.execute(
      { tenant_id: "t1" } as never,
      { date_preset: "last_7d", status: "ALL" },
    )) as { campaigns: unknown[]; totals: Record<string, unknown> };

    expect(out.campaigns).toHaveLength(21);
    expect(out.totals.entities).toBe(21);
    expect(out.totals.spend_usd).toBeCloseTo(1083.6, 1);
    expect(out.totals.purchase_value_usd).toBeCloseTo(1463.7, 1);
    expect(out.totals.roas).toBe(1.35);
    expect(out.totals.complete).toBe(true);

    const cap = toolResultCapBytes("meta_ads", "list_campaigns");
    const atRealCap = JSON.parse(smartTruncateToolResult(JSON.stringify(out), cap));
    expect(atRealCap._truncated).toBeUndefined();
    expect(atRealCap.campaigns).toHaveLength(21);

    const capped = JSON.parse(smartTruncateToolResult(JSON.stringify(out), 2048));
    expect(capped._truncated).toBe(true);
    expect(capped._total).toBe(21);
    expect(capped.campaigns.length).toBeLessThan(21);
    expect(capped.totals.roas).toBe(1.35);
  });

  it("says so when the account has more rows than one page", async () => {
    fbGet.mockImplementation(async (_tenant: string, path: string) => {
      if (path.endsWith("/insights"))
        return { data: insightRows(), paging: { next: "https://graph.facebook.com/next" } };
      return { data: [] };
    });
    const out = (await metaListCampaignsTool.execute(
      { tenant_id: "t1" } as never,
      { date_preset: "last_7d", status: "ALL" },
    )) as { totals: Record<string, unknown> };

    expect(out.totals.complete).toBe(false);
    expect(String(out.totals.note)).toMatch(/page/i);
  });

  it("keeps totals under the 512-byte sibling budget with real field values", async () => {
    const out = (await metaListCampaignsTool.execute(
      { tenant_id: "t1" } as never,
      { date_preset: "last_7d", status: "ALL" },
    )) as { totals: Record<string, unknown> };
    expect(Buffer.byteLength(JSON.stringify(out.totals), "utf-8")).toBeLessThanOrEqual(512);
  });
});
