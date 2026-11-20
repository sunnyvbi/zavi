
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  cgoOn: false,
  search: vi.fn(),
  country: null as { code: string; name: string } | null,
  countryThrows: false,
}));
vi.mock("@/services/ad-locations/country", async (orig) => ({
  ...(await orig<typeof import("@/services/ad-locations/country")>()),
  businessCountry: vi.fn(async () => h.country),
  businessCountryOrThrow: vi.fn(async () => {
    if (h.countryThrows) throw new Error("company record unreadable");
    return h.country;
  }),
}));
vi.mock("../_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => true }));
vi.mock("../_video-guard", () => ({ assertNotVideoCampaign: vi.fn(), assertNotVideoAdGroup: vi.fn() }));
vi.mock("../cap-reader", () => ({ readTenantGoogleCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0 })) }));
vi.mock("../_currency-guard", () => ({ assertUsdGoogleAccount: vi.fn(async () => {}), googleCurrencyRefusal: vi.fn() }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: vi.fn(async () => (h.cgoOn ? { id: "b1" } : null)) }));
vi.mock("../../_client", async (orig) => ({ ...(await orig<typeof import("../../_client")>()), gadsSearch: h.search }));

import { googleProposeNewCampaignTool } from "../propose_new_campaign";
import { withClickBiddingWhenBlind, withCountryDefault } from "../_launch-defaults";
import { createCampaignBodySchema } from "../_decision-bodies";
import { evaluateUnattended } from "@/services/growth/unattended-policy";
import type { ToolContext } from "@/services/tools/types";

const TENANT = "11111111-1111-4111-8111-111111111111";
const input = {
  name: "Search launch",
  channel_type: "SEARCH",
  daily_budget_usd: 50,
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  rationale: "launch",
};

function ctx() {
  const emit = vi.fn(async (_c: string, _b: unknown) => "d-1");
  const c: ToolContext = { tenant_id: TENANT, log: () => {}, emit_decision: emit };
  return { c, emit };
}

function account(o: { country: string | null; conversions: number }) {
  h.country = o.country ? { code: o.country, name: o.country } : null;
  h.search.mockImplementation(async (_t: string, q: string) => {
    if (q.includes("campaign_criterion")) throw new Error("older campaigns must never be read for the default");
    return [{ metrics: { conversions: o.conversions } }];
  });
}

beforeEach(() => {
  h.cgoOn = false;
  h.country = null;
  h.countryThrows = false;
  h.search.mockReset();
});

describe("acceptance 8: Google create location under Autopilot", () => {
  it("no location + a known country -> the create targets the whole country (Google id 2000 + ISO numeric)", async () => {
    h.cgoOn = true;
    account({ country: "US", conversions: 5 });
    const { c, emit } = ctx();
    await googleProposeNewCampaignTool.execute(c, input);
    const body = emit.mock.calls[0][1] as { location_ids: number[] };
    expect(body.location_ids).toEqual([2840]);
    const v = evaluateUnattended(
      { kind: "ad", exec_class: "google_ads.create_campaign", payload: body, source: { table: "channel_actions", id: "a", run_id: null } },
      { refsResolved: true, openAdvice: "clear", goal: { present: false } },
    );
    expect(v.reasons).not.toContain("no_location_target");
  });

  it("no location + no known country -> no location, and the gate asks the founder", async () => {
    h.cgoOn = true;
    account({ country: null, conversions: 5 });
    const { c, emit } = ctx();
    await googleProposeNewCampaignTool.execute(c, input);
    const body = emit.mock.calls[0][1] as { location_ids: number[] };
    expect(body.location_ids).toEqual([]);
    const v = evaluateUnattended(
      { kind: "ad", exec_class: "google_ads.create_campaign", payload: body, source: { table: "channel_actions", id: "a", run_id: null } },
      { refsResolved: true, openAdvice: "clear", goal: { present: false } },
    );
    expect(v).toMatchObject({ verdict: "ask_founder", reasons: expect.arrayContaining(["no_location_target"]) });
  });

  it("a location the run chose is never replaced", async () => {
    h.cgoOn = true;
    account({ country: "GB", conversions: 5 });
    const { c, emit } = ctx();
    await googleProposeNewCampaignTool.execute(c, { ...input, location_ids: [2840] });
    expect((emit.mock.calls[0][1] as { location_ids: number[] }).location_ids).toEqual([2840]);
  });

  it("S2: under Autopilot, no conversions in 30 days -> click bidding on the card", async () => {
    h.cgoOn = true;
    account({ country: "GB", conversions: 0 });
    const { c, emit } = ctx();
    await googleProposeNewCampaignTool.execute(c, input);
    expect((emit.mock.calls[0][1] as { bidding: unknown }).bidding).toEqual({ strategy: "TARGET_SPEND" });
  });

  it("a founder-run account (no Autopilot budget): the country default still applies, bidding is untouched", async () => {
    h.cgoOn = false;
    account({ country: "US", conversions: 0 });
    const { c, emit } = ctx();
    await googleProposeNewCampaignTool.execute(c, input);
    const body = emit.mock.calls[0][1] as { location_ids: number[]; bidding: unknown };
    expect(body.location_ids).toEqual([2840]);
    expect(body.bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS" });
  });
});

describe("gaps #14: a founder's chat launch with no location runs in the business's country", () => {
  it("must catch: a founder chat turn ('launch a campaign for new customers', no place named) -> the country, not the world; their bidding kept", async () => {
    h.cgoOn = true;
    account({ country: "GB", conversions: 0 });
    const { c, emit } = ctx();
    c.run_trigger = "chat";
    await googleProposeNewCampaignTool.execute(c, input);
    const body = emit.mock.calls[0][1] as { location_ids: number[]; bidding: unknown };
    expect(body.location_ids).toEqual([2826]);
    expect(body.bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS" });
  });

  it("must not catch: a founder who names places keeps exactly those places", async () => {
    h.cgoOn = false;
    account({ country: "US", conversions: 5 });
    const { c, emit } = ctx();
    c.run_trigger = "chat";
    await googleProposeNewCampaignTool.execute(c, { ...input, location_ids: [21137, 21167] });
    expect((emit.mock.calls[0][1] as { location_ids: number[] }).location_ids).toEqual([21137, 21167]);
  });

  it("must catch: an unreadable company record refuses the proposal, never a worldwide campaign", async () => {
    h.countryThrows = true;
    account({ country: "US", conversions: 5 });
    h.countryThrows = true;
    const { c, emit } = ctx();
    c.run_trigger = "chat";
    await expect(googleProposeNewCampaignTool.execute(c, input)).rejects.toMatchObject({ code: "google_ads_location_unreadable" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("no known country: the founder's launch stays without a location (nothing invented)", async () => {
    h.cgoOn = false;
    account({ country: null, conversions: 5 });
    const { c, emit } = ctx();
    c.run_trigger = "chat";
    await googleProposeNewCampaignTool.execute(c, input);
    expect((emit.mock.calls[0][1] as { location_ids: number[] }).location_ids).toEqual([]);
  });

  it("review Q6: the founder's own command is stamped origin user_initiated_chat (kept by the dispatch schema); a cron run's is not", async () => {
    h.cgoOn = true;
    account({ country: "GB", conversions: 5 });
    const chat = ctx();
    chat.c.run_trigger = "chat";
    await googleProposeNewCampaignTool.execute(chat.c, input);
    const body = chat.emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.origin).toBe("user_initiated_chat");
    expect(createCampaignBodySchema.parse(body).origin).toBe("user_initiated_chat");
    const cron = ctx();
    cron.c.run_trigger = "cron";
    await googleProposeNewCampaignTool.execute(cron.c, { ...input, origin: "user_initiated_chat" });
    expect((cron.emit.mock.calls[0][1] as Record<string, unknown>).origin).toBeUndefined();
  });

  it("a chat turn only a company rule steered, or one carrying a captured page, is not the founder's command: defaults apply", async () => {
    for (const over of [{ rules_steered: { budget: true, status: false } }, { untrusted_context: true }]) {
      h.cgoOn = true;
      h.search.mockReset();
      account({ country: "GB", conversions: 0 });
      const { c, emit } = ctx();
      Object.assign(c, { run_trigger: "chat", ...over });
      await googleProposeNewCampaignTool.execute(c, input);
      const body = emit.mock.calls[0][1] as { location_ids: number[]; bidding: unknown };
      expect(body.location_ids, JSON.stringify(over)).toEqual([2826]);
      expect(body.bidding).toEqual({ strategy: "TARGET_SPEND" });
    }
  });
});

describe("the pure halves", () => {
  it("country default: fills only an empty list, and only with a known country", () => {
    expect(withCountryDefault({ location_ids: [] }, null)).toEqual({ location_ids: [] });
    expect(withCountryDefault({ location_ids: [] }, 2840)).toEqual({ location_ids: [2840] });
    expect(withCountryDefault({ location_ids: [1014221] }, 2840)).toEqual({ location_ids: [1014221] });
  });

  it("click bidding only when the count is a real zero and the channel takes it", () => {
    const search = { channel_type: "SEARCH" as const, bidding: { strategy: "MAXIMIZE_CONVERSIONS" as const } };
    expect(withClickBiddingWhenBlind(search, null)).toBe(search);
    expect(withClickBiddingWhenBlind(search, 3)).toBe(search);
    expect(withClickBiddingWhenBlind(search, 0).bidding).toEqual({ strategy: "TARGET_SPEND" });
    const pmax = { channel_type: "PERFORMANCE_MAX" as const, bidding: { strategy: "MAXIMIZE_CONVERSIONS" as const } };
    expect(withClickBiddingWhenBlind(pmax, 0)).toBe(pmax);
    const manual = { channel_type: "SEARCH" as const, bidding: { strategy: "MANUAL_CPC" as const, enhanced_cpc: false } };
    expect(withClickBiddingWhenBlind(manual, 0)).toBe(manual);
  });
});
