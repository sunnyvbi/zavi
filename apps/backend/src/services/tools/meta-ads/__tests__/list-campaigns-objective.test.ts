import { describe, it, expect, vi, beforeEach } from "vitest";

const fbGet = vi.fn();
vi.mock("../_client", async () => {
  const actual = await vi.importActual<typeof import("../_client")>("../_client");
  return {
    ...actual,
    fbGet: (...a: unknown[]) => fbGet(...a),
    metaAdsCreds: async () => ({ access_token: "t", ad_account_id: "act_1" }),
  };
});

import { metaListCampaignsTool } from "../list_campaigns";
import { metaJudgedOn } from "../_objective";

const insight = (id: string, name: string, spend: string, objective: string, purchases = "0") => ({
  campaign_id: id, campaign_name: name, objective, spend, impressions: "10000", clicks: "300",
  actions: [{ action_type: "purchase", value: purchases }],
});

type Out = {
  campaigns: Array<Record<string, unknown>>;
  waste?: { scope: string; lines: Array<{ label: string }>; spend_total: number; excluded_total?: number };
};

beforeEach(() => {
  fbGet.mockReset();
});

describe("meta_ads__list_campaigns objective", () => {
  it("requests objective on both the insights and the campaigns edge", async () => {
    fbGet.mockResolvedValue({ data: [] });
    await metaListCampaignsTool.execute({ tenant_id: "t1" } as never, { status: "ALL" });
    const fields = fbGet.mock.calls.map((c) => String((c[2] as { fields?: string }).fields ?? ""));
    expect(fields.every((f) => f.split(",").includes("objective"))).toBe(true);
    expect(fields).toHaveLength(2);
  });

  it("marks each row with judged_on and keeps reach-and-clicks zero results out of waste", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) =>
      path.endsWith("/insights")
        ? { data: [insight("1", "Awareness push", "300", "OUTCOME_AWARENESS"), insight("2", "Sales dud", "120", "OUTCOME_SALES")] }
        : { data: [] },
    );
    const out = (await metaListCampaignsTool.execute({ tenant_id: "t1" } as never, { status: "ACTIVE" })) as Out;
    expect(out.campaigns.map((c) => c.judged_on)).toEqual(["reach_and_clicks", "conversions"]);
    expect(out.campaigns[0].objective).toBe("OUTCOME_AWARENESS");
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["Sales dud"]);
    expect(out.waste?.spend_total).toBe(120);
    expect(out.waste?.excluded_total).toBe(1);
    expect(out.waste?.scope).toMatch(/1 more left out: their objective buys reach or clicks/);
  });

  it("prefers the campaign's own objective over the insights value", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) =>
      path.endsWith("/insights")
        ? { data: [insight("1", "Traffic", "50", "OUTCOME_SALES")] }
        : { data: [{ id: "1", name: "Traffic", status: "ACTIVE", objective: "OUTCOME_TRAFFIC" }] },
    );
    const out = (await metaListCampaignsTool.execute({ tenant_id: "t1" } as never, { status: "ALL" })) as Out;
    expect(out.campaigns[0]).toMatchObject({ objective: "OUTCOME_TRAFFIC", judged_on: "reach_and_clicks" });
  });

  it("an OUTCOME_ENGAGEMENT campaign with no results stays in waste", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) =>
      path.endsWith("/insights") ? { data: [insight("3", "Messages push", "300", "OUTCOME_ENGAGEMENT")] } : { data: [] },
    );
    const out = (await metaListCampaignsTool.execute({ tenant_id: "t1" } as never, { status: "ACTIVE" })) as Out;
    expect(out.campaigns[0].judged_on).toBe("unknown");
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["Messages push"]);
    expect(out.waste?.excluded_total).toBeUndefined();
  });

  it("an unknown or missing objective keeps today's waste behaviour", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) =>
      path.endsWith("/insights") ? { data: [{ campaign_id: "9", campaign_name: "No objective", spend: "80", actions: [] }] } : { data: [] },
    );
    const out = (await metaListCampaignsTool.execute({ tenant_id: "t1" } as never, { status: "ACTIVE" })) as Out;
    expect(out.campaigns[0].judged_on).toBe("unknown");
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["No objective"]);
    expect(out.waste?.excluded_total).toBeUndefined();
  });
});

describe("metaJudgedOn", () => {
  it("lets a known ad-set goal win over the campaign objective", () => {
    expect(metaJudgedOn("OUTCOME_ENGAGEMENT", "CONVERSATIONS")).toBe("conversions");
    expect(metaJudgedOn("OUTCOME_SALES", "LANDING_PAGE_VIEWS")).toBe("reach_and_clicks");
    expect(metaJudgedOn("OUTCOME_SALES", "SOMETHING_NEW")).toBe("conversions");
    expect(metaJudgedOn("MESSAGES")).toBe("unknown");
  });

  it("OUTCOME_ENGAGEMENT without an ad set goal is unknown, not reach_and_clicks", () => {
    expect(metaJudgedOn("OUTCOME_ENGAGEMENT")).toBe("unknown");
    expect(metaJudgedOn("OUTCOME_ENGAGEMENT", null)).toBe("unknown");
    expect(metaJudgedOn("OUTCOME_ENGAGEMENT", "POST_ENGAGEMENT")).toBe("reach_and_clicks");
    expect(metaJudgedOn("OUTCOME_ENGAGEMENT", "CONVERSATIONS")).toBe("conversions");
    expect(metaJudgedOn(null)).toBe("unknown");
  });
});
