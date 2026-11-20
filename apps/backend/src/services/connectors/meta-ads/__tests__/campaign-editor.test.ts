
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  writeEnabled: true,
  currency: "USD",
  account: "act_1",
  campaign: {} as Record<string, unknown>,
  adsets: [] as Array<Record<string, unknown>>,
  emitted: [] as Array<{ cls: string; body: Record<string, unknown> }>,
  rowOverride: null as null | Record<string, unknown>,
  decided: [] as string[],
  decideCode: "ok",
  decideStatus: null as string | null,
  rowStatus: "proposed",
  pixels: [{ id: "777" }] as Array<{ id: string }>,
  capRead: { cap: null as null | Record<string, unknown>, cap_row_absent: true },
  failEmitAt: 0,
  decideThrows: false,
  afterDecideStatus: "proposed",
  readFails: false,
  sent: [] as Array<{ id: string; name: string }>,
  sendFails: false,
  adsReadFails: false,
}));

vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async () => ({ ad_account_id: g.account }),
  getAdAccountCurrency: async () => g.currency,
  fbGet: async (_t: string, path: string, params: Record<string, string>) => {
    if (path.endsWith("/adsets")) return { data: g.adsets };
    if (path.endsWith("/ads")) {
      if (g.adsReadFails) throw new Error("Graph 500");
      return { data: [] };
    }
    if (path.endsWith("/adspixels")) return { data: g.pixels };
    if (path === "search") {
      const out: Record<string, Record<string, unknown>> = { countries: {}, regions: {}, cities: {} };
      for (const [k, bucket] of [["countries", "countries"], ["regions", "regions"], ["cities", "cities"]] as const) {
        for (const key of JSON.parse(params[k] ?? "[]") as string[]) out[bucket]![key] = { key, name: `Place ${key}` };
      }
      return { data: out };
    }
    return g.campaign;
  },
}));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: async () => g.writeEnabled }));
vi.mock("@/services/tools/meta-ads/write/_library-ad-capability", () => ({ resolveMetaAdCapability: async () => ({ ok: true, ad_account_id: "act_1", page_id: "5" }) }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: async () => ({ ...g.capRead, today_total_change_usd: 0, currency: g.currency }) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (_t: string, fn: string, args: { p_decision_class: string; p_body: Record<string, unknown> }) => {
    expect(fn).toBe("emit_decision");
    if (g.failEmitAt === g.emitted.length + 1) return { data: null, error: { message: "db down" } };
    g.emitted.push({ cls: args.p_decision_class, body: JSON.parse(JSON.stringify(args.p_body)) });
    return { data: `d-${g.emitted.length}`, error: null };
  },
  tenantClient: (t: string) => ({
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, v: string) => {
          expect([table, t, col]).toEqual(["decisions", "t-1", "id"]);
          expect(v).toBe(`d-${g.emitted.length}`);
          return {
            maybeSingle: async () => {
              if (g.readFails) return { data: null, error: { message: "read timeout" } };
              const last = g.emitted[g.emitted.length - 1]!;
              const status = g.decided.includes(v) ? g.afterDecideStatus : g.rowStatus;
              return { data: g.rowOverride ?? { decision_class: last.cls, status, body: last.body }, error: null };
            },
          };
        },
      }),
    }),
  }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: async (e: { id: string; name: string }) => { if (g.sendFails) throw new Error("inngest down"); g.sent.push(e); } } }));
vi.mock("@/services/approvals/decide-service", () => ({
  decideOnDecision: async (a: { decision_id: string; action: string; actor: { user_id: string } }) => {
    expect(a.action).toBe("approve");
    expect(a.actor.user_id).toBe("u-1");
    g.decided.push(a.decision_id);
    if (g.decideThrows) throw new Error("decide blew up");
    return { ok: g.decideCode === "ok", code: g.decideCode, status: g.decideStatus };
  },
}));

import { createMetaAd, createMetaAdSet, createMetaCampaign, metaAdCreateSchema, metaCampaignCreateSchema, readMetaCampaignEditor, saveMetaCampaignEdits, budgetLevel } from "../campaign-editor";
import { EditorPartialSaveError } from "@/services/connectors/_editor-save";

const T = "t-1" as never;

beforeEach(() => {
  g.writeEnabled = true;
  g.currency = "USD";
  g.account = "act_1";
  g.campaign = { id: "12000100", account_id: "1", name: "Spring", status: "ACTIVE", objective: "OUTCOME_TRAFFIC", daily_budget: "5000", spend_cap: null };
  g.adsets = [
    { id: "12000200", name: "US adults", status: "ACTIVE", end_time: "2026-12-01T00:00:00+0000", targeting: { geo_locations: { countries: ["US"] }, publisher_platforms: ["facebook"] } },
  ];
  g.emitted = [];
  g.rowOverride = null;
  g.decided = [];
  g.decideCode = "ok";
  g.decideStatus = null;
  g.rowStatus = "proposed";
  g.pixels = [{ id: "777" }];
  g.capRead = { cap: null, cap_row_absent: true };
  g.failEmitAt = 0;
  g.decideThrows = false;
  g.afterDecideStatus = "proposed";
  g.readFails = false;
  g.sent = [];
  g.sendFails = false;
  g.adsReadFails = false;
});

describe("saveMetaCampaignEdits", () => {
  it("stages and approves only what changed, with current values read from Meta", async () => {
    const out = await saveMetaCampaignEdits(T, "u-1", "12000100", {
      name: "Spring v2",
      spend_cap: 500,
      ad_set: { id: "12000200", end_time: "2027-01-01T00:00:00+00:00", placements: ["facebook", "instagram"], places: ["country:US"] },
    });
    expect(g.emitted.map((e) => e.cls)).toEqual(["meta_ads.update_campaign", "meta_ads.update_ad_set"]);
    expect(g.emitted[0]!.body).toMatchObject({ campaign_id: "12000100", new_name: "Spring v2", spend_cap_usd: 500, expected_current_spend_cap_usd: null, origin: "user_initiated_ledger" });
    expect(g.emitted[1]!.body).toMatchObject({
      ad_set_id: "12000200",
      end_time: "2027-01-01T00:00:00+00:00",
      expected_current_end_time: "2026-12-01T00:00:00+00:00",
      targeting_patch: { publisher_platforms: ["facebook", "instagram"] },
      origin: "user_initiated_ledger",
    });
    expect(g.emitted[1]!.body.expected_targeting_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(out.every((c) => c.approved)).toBe(true);
    expect(g.decided).toEqual(["d-1", "d-2"]);
  });

  it("a Save with nothing new stages nothing", async () => {
    const out = await saveMetaCampaignEdits(T, "u-1", "12000100", { name: "Spring", ad_set: { id: "12000200", placements: ["facebook"], places: ["country:US"] } });
    expect(out).toEqual([]);
    expect(g.emitted).toEqual([]);
  });

  it("new places are a founder-origin geo replace on the fingerprint Meta shows now", async () => {
    await saveMetaCampaignEdits(T, "u-1", "12000100", { ad_set: { id: "12000200", places: ["country:CA", "city:2421836"] } });
    expect(g.emitted[0]!.cls).toBe("meta_ads.replace_ad_set_geo_review");
    expect(g.emitted[0]!.body).toMatchObject({ ad_set_id: "12000200", origin: "user_initiated_ledger", before_names: ["US"] });
    expect(g.emitted[0]!.body.places).toEqual([
      { type: "country", key: "CA", name: "Place CA" },
      { type: "city", key: "2421836", name: "Place 2421836" },
    ]);
  });

  it("a change the approval does not take waits in Approvals and says why", async () => {
    g.decideCode = "budget_choice_required";
    const [c] = await saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 900 });
    expect(c).toMatchObject({ approved: false, code: "budget_choice_required" });
  });

  it("refuses when Meta writes are off, for another account's campaign, and when an open card was handed back", async () => {
    g.writeEnabled = false;
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { name: "x" })).rejects.toMatchObject({ code: "meta_ads_write_disabled" });
    g.writeEnabled = true;
    g.campaign = { ...g.campaign, account_id: "999" };
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { name: "x" })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    g.campaign = { ...g.campaign, account_id: "1" };
    g.rowOverride = { decision_class: "meta_ads.update_campaign", status: "proposed", body: { campaign_id: "12000100", new_name: "someone else's" } };
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { name: "x" })).rejects.toMatchObject({ code: "meta_editor_change_open" });
    expect(g.decided).toEqual([]);
  });

  it("every read and check runs before anything is staged: a bad ad set stages not even the rename", async () => {
    await expect(
      saveMetaCampaignEdits(T, "u-1", "12000100", { name: "Spring v2", ad_set: { id: "12000999", end_time: "2027-01-01T00:00:00+00:00" } }),
    ).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(g.emitted).toEqual([]);
    expect(g.decided).toEqual([]);
  });

  it("a later change that fails after one landed names what was saved and what was not", async () => {
    g.failEmitAt = 2;
    const err = await saveMetaCampaignEdits(T, "u-1", "12000100", {
      name: "Spring v2",
      ad_set: { id: "12000200", end_time: "2027-01-01T00:00:00+00:00" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EditorPartialSaveError);
    expect((err as EditorPartialSaveError).landed).toMatchObject([{ label: 'Spring: rename to "Spring v2"', decision_id: "d-1", approved: true }]);
    expect((err as EditorPartialSaveError).failed_label).toBe("US adults: end date");
    expect(g.decided).toEqual(["d-1"]);
  });

  it("an approve whose answer was lost reports the row as it stands, never as nothing saved", async () => {
    g.decideThrows = true;
    const [c] = await saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 900 });
    expect(c).toMatchObject({ decision_id: "d-1", approved: false, code: "approve_failed" });
    g.afterDecideStatus = "approved";
    const [d] = await saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 800 });
    expect(d).toMatchObject({ approved: true, code: null });
    expect(g.sent).toEqual([expect.objectContaining({ id: "approve:d-2", name: "decision.approved" })]);
    g.afterDecideStatus = "dispatching";
    const [e] = await saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 700 });
    expect(e).toMatchObject({ approved: true });
    expect(g.sent).toHaveLength(1);
    g.afterDecideStatus = "approved";
    g.sendFails = true;
    const [f] = await saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 600 });
    expect(f).toMatchObject({ approved: false, code: "dispatch_unsent" });
  });

  it("a staged row that cannot be read back is never called not saved, and is never approved blind", async () => {
    g.readFails = true;
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { spend_cap: 900 })).rejects.toMatchObject({
      code: "meta_editor_stage_unknown",
      meta: { decision_id: "d-1" },
    });
    expect(g.decided).toEqual([]);
  });

  it("an ad set from another campaign is refused", async () => {
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { ad_set: { id: "12000999", end_time: "2027-01-01T00:00:00+00:00" } })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
  });
});

describe("createMetaCampaign", () => {
  const form = {
    name: "Winter",
    goal: "traffic" as const,
    daily_budget: 40,
    places: ["country:US"],
    headline: "Rent a car",
    primary_text: "Cars near you",
    link_url: "https://example.com",
    image_url: "https://example.com/i.png",
  };

  it("files one launch built paused, founder-origin, and approves it", async () => {
    const c = await createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse(form));
    expect(g.emitted).toHaveLength(1);
    const { cls, body } = g.emitted[0]!;
    expect(cls).toBe("meta_ads.launch_campaign");
    expect(body).toMatchObject({
      switch_on: false,
      origin: "user_initiated_ledger",
      campaign: { name: "Winter", objective: "OUTCOME_TRAFFIC", daily_budget_usd: 40 },
      ad_set: { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] } } },
      ad: { headline: "Rent a car", link_url: "https://example.com", image_url: "https://example.com/i.png" },
    });
    expect(c.approved).toBe(true);
  });

  it("a conversions campaign counts the picked event on the account's pixel", async () => {
    await createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse({ ...form, goal: "conversions", conversion_event: "PURCHASE" }));
    expect(g.emitted[0]!.body).toMatchObject({ campaign: { objective: "OUTCOME_SALES" }, ad_set: { promoted_object: { pixel_id: "777", custom_event_type: "PURCHASE" } } });
    g.pixels = [];
    await expect(createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse({ ...form, goal: "conversions", conversion_event: "LEAD" }))).rejects.toMatchObject({ code: "meta_editor_no_pixel" });
  });

  it("a Meta daily limit that could not be read refuses the build (fail closed); a read with no limit row goes on", async () => {
    g.capRead = { cap: null, cap_row_absent: false } as never;
    await expect(createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse(form))).rejects.toMatchObject({ code: "meta_editor_cap_unreadable" });
    expect(g.emitted).toEqual([]);
    g.capRead = { cap: { enabled: true, max_daily_budget_usd: 30, max_pct_change_per_run: 50, max_daily_total_change_usd: 100 }, cap_row_absent: false } as never;
    await expect(createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse(form))).rejects.toMatchObject({ code: "meta_editor_over_cap" });
    expect(g.emitted).toEqual([]);
    g.capRead = { cap: null, cap_row_absent: true };
    expect((await createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse(form))).approved).toBe(true);
  });

  it("refuses a typo-sized budget before anything is filed", async () => {
    await expect(createMetaCampaign(T, "u-1", metaCampaignCreateSchema.parse({ ...form, daily_budget: 20_000 }))).rejects.toMatchObject({ code: "meta_editor_budget_typo" });
    expect(g.emitted).toEqual([]);
  });

  it("the form needs a conversion event for conversions, and https links", () => {
    expect(metaCampaignCreateSchema.safeParse({ ...form, goal: "conversions" }).success).toBe(false);
    expect(metaCampaignCreateSchema.safeParse({ ...form, link_url: "http://example.com" }).success).toBe(false);
  });
});

describe("createMetaAdSet", () => {
  const input = { name: "Texas", daily_budget: 20, places: ["country:US"], age_min: 21, age_max: 55 };

  it("files a paused ad set for the campaign's own objective and approves it", async () => {
    g.campaign = { ...g.campaign, daily_budget: null };
    const out = await createMetaAdSet(T, "u-1", "12000100", input);
    expect(g.emitted.map((e) => e.cls)).toEqual(["meta_ads.create_ad_set"]);
    expect(g.emitted[0]!.body).toMatchObject({
      campaign_id: "12000100",
      name: "Texas",
      daily_budget_usd: 20,
      currency: "USD",
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["US"] }, age_min: 21, age_max: 55 },
    });
    expect(g.decided).toEqual(["d-1"]);
    expect(out).toMatchObject({ decision_id: "d-1", approved: true });
  });

  it("a sales campaign counts the picked event on the account's pixel, and needs one picked", async () => {
    g.campaign = { ...g.campaign, daily_budget: null, objective: "OUTCOME_SALES" };
    await expect(createMetaAdSet(T, "u-1", "12000100", input)).rejects.toMatchObject({ code: "meta_editor_invalid" });
    await createMetaAdSet(T, "u-1", "12000100", { ...input, conversion_event: "PURCHASE" });
    expect(g.emitted).toHaveLength(1);
    expect(g.emitted[0]!.body).toMatchObject({ optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "777", custom_event_type: "PURCHASE" } });
  });

  it("refuses a campaign that holds the budget, an objective it cannot match, and a budget over the limit, with nothing filed", async () => {
    await expect(createMetaAdSet(T, "u-1", "12000100", input)).rejects.toMatchObject({ code: "meta_editor_campaign_budget" });
    g.campaign = { ...g.campaign, daily_budget: null, objective: "OUTCOME_LEADS" };
    await expect(createMetaAdSet(T, "u-1", "12000100", input)).rejects.toMatchObject({ code: "meta_editor_objective_unsupported" });
    g.capRead = { cap: { enabled: true, max_daily_budget_usd: 10 }, cap_row_absent: false };
    await expect(createMetaAdSet(T, "u-1", "12000100", input)).rejects.toMatchObject({ code: "meta_editor_over_cap" });
    expect(g.emitted).toEqual([]);
  });
});

describe("createMetaAd", () => {
  const input = metaAdCreateSchema.parse({ ad_set_id: "12000200", name: "Spring ad", headline: "Rent a car", primary_text: "From $35 a day", link_url: "https://example.com", image_url: "https://example.com/a.jpg", cta: "LEARN_MORE" });

  it("files a founder-origin ad in the campaign's ad set and approves it", async () => {
    await createMetaAd(T, "u-1", "12000100", input);
    expect(g.emitted.map((e) => e.cls)).toEqual(["meta_ads.create_ad"]);
    expect(g.emitted[0]!.body).toMatchObject({ ad_set_id: "12000200", headline: "Rent a car", link_url: "https://example.com", source: "library", origin: "user_initiated_ledger" });
    expect(g.decided).toEqual(["d-1"]);
  });

  it("refuses an ad set from another campaign and a link that is not https", async () => {
    await expect(createMetaAd(T, "u-1", "12000100", { ...input, ad_set_id: "99999999" })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(g.emitted).toEqual([]);
    expect(metaAdCreateSchema.safeParse({ ...input, link_url: "http://example.com" }).success).toBe(false);
  });
});

describe("budgetLevel", () => {
  it("names who holds the daily budget", () => {
    expect(budgetLevel({ daily_budget: "100" }, [])).toBe("campaign");
    expect(budgetLevel({ lifetime_budget: "100" }, [])).toBe("lifetime");
    expect(budgetLevel({}, [{ daily_budget: "100" }])).toBe("ad_set");
    expect(budgetLevel({}, [{ daily_budget: "100" }, { daily_budget: "50" }])).toBe("mixed");
    expect(budgetLevel({}, [{}])).toBe("none");
  });
});

describe("stage-and-approve edge cases", () => {
  it("a class this workspace forbids is said so, not blamed on another open change", async () => {
    g.rowStatus = "rejected";
    await expect(saveMetaCampaignEdits(T, "u-1", "12000100", { name: "x" })).rejects.toMatchObject({ code: "meta_editor_forbidden" });
    expect(g.decided).toEqual([]);
  });

  it("a row already approved by the time the Save approves counts as approved", async () => {
    g.decideCode = "decision_closed";
    g.decideStatus = "approved";
    const [c] = await saveMetaCampaignEdits(T, "u-1", "12000100", { name: "x" });
    expect(c).toMatchObject({ approved: true, code: null });
  });
});

describe("readMetaCampaignEditor", () => {
  it("a failed ads read is an error, never an empty Ads section", async () => {
    g.adsReadFails = true;
    await expect(readMetaCampaignEditor("t-1", "12000100")).rejects.toThrow("Graph 500");
  });
});
