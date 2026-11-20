
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));
const capState = vi.hoisted(() => ({ cap: null as unknown }));
vi.mock("../cap-reader", () => { const m = ({ readTenantCapAndToday: vi.fn(async () => ({ cap: capState.cap, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })) }); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeCustomAudienceTool, metaProposeDuplicateTool, metaProposeNewAdTool } from "../propose_launch";
import {
  launchTag,
  nameHasTag,
  readCopyResult,
  shapeCopyAdSetRequest,
  shapeLaunchAdRequest,
  shapeLaunchCreativeRequest,
  shapeSetDailyBudgetRequest,
  shapeWebsiteAudienceRequest,
  taggedName,
} from "../_launch-shapers";
import { metaChangeRows } from "../_change-rows";
import { metaExecActionType } from "../_exec-action";
import { adShape, evaluateUnattended } from "@/services/growth/unattended-policy";
import { ADS_CAP_BYPASS_CLASSES } from "@/services/decisions/ads-approval-authority";
import type { ToolContext } from "@/services/tools/types";
import { createAdBodySchema, createCustomAudienceBodySchema, duplicateAdSetBodySchema } from "../_decision-bodies";
import { cgoApproveAdDecision } from "@/services/growth/cgo-ads";

function ctx() {
  const emit = vi.fn(async (_c: string, _b: unknown) => "d-1");
  const c: ToolContext = { tenant_id: "t-1", log: () => {}, emit_decision: emit };
  return { c, emit };
}

beforeEach(() => {
  capState.cap = null;
});

describe("propose tools: each parses the dispatch schema and emits its approval-only class", () => {
  it("duplicate: an ad set source emits meta_ads.duplicate_ad_set; a campaign source duplicate_campaign", async () => {
    const a = ctx();
    await metaProposeDuplicateTool.execute(a.c, { source_ad_set_id: "2220001", daily_budget_usd: 150, rationale: "scale the winner" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.duplicate_ad_set", expect.objectContaining({ source_ad_set_id: "2220001", daily_budget_usd: 150 }));
    const b = ctx();
    await metaProposeDuplicateTool.execute(b.c, { source_campaign_id: "1110001", daily_budget_usd: 150, rationale: "cbo" });
    expect(b.emit.mock.calls[0][0]).toBe("meta_ads.duplicate_campaign");
  });

  it("duplicate: both sources, neither, a non-id, or over the tenant ceiling is refused with nothing emitted", async () => {
    const a = ctx();
    await expect(metaProposeDuplicateTool.execute(a.c, { daily_budget_usd: 10, rationale: "x" })).rejects.toMatchObject({ code: "meta_ads_invalid_launch_body" });
    await expect(
      metaProposeDuplicateTool.execute(a.c, { source_ad_set_id: "2220001", source_campaign_id: "1110001", daily_budget_usd: 10, rationale: "x" }),
    ).rejects.toMatchObject({ code: "meta_ads_invalid_launch_body" });
    await expect(metaProposeDuplicateTool.execute(a.c, { source_ad_set_id: "Winners", daily_budget_usd: 10, rationale: "x" })).rejects.toMatchObject({
      code: "meta_ads_invalid_launch_body",
    });
    capState.cap = { enabled: true, max_daily_budget_usd: 100 };
    await expect(metaProposeDuplicateTool.execute(a.c, { source_ad_set_id: "2220001", daily_budget_usd: 101, rationale: "x" })).rejects.toMatchObject({
      code: "meta_ads_proposal_over_absolute_cap",
    });
    expect(a.emit).not.toHaveBeenCalled();
  });

  it("new ad: needs media (or a source ad to copy it from) and an https link", async () => {
    const a = ctx();
    const base = { ad_set_id: "2220001", primary_text: "p", headline: "h", link_url: "https://x.com", source: "zavi_generated", rationale: "r" };
    await expect(metaProposeNewAdTool.execute(a.c, base)).rejects.toMatchObject({ code: "meta_ads_invalid_launch_body" });
    await expect(metaProposeNewAdTool.execute(a.c, { ...base, image_url: "https://x.com/i.png", link_url: "http://x.com" })).rejects.toMatchObject({
      code: "meta_ads_invalid_launch_body",
    });
    await metaProposeNewAdTool.execute(a.c, { ...base, image_url: "https://x.com/i.png" });
    await metaProposeNewAdTool.execute(a.c, { ...base, source: "copy", source_ad_id: "3330001" });
    expect(a.emit.mock.calls.map((c) => c[0])).toEqual(["meta_ads.create_ad", "meta_ads.create_ad"]);
  });

  it("audience: the server names it, so the card and the open-advice match have a name", async () => {
    const a = ctx();
    await metaProposeCustomAudienceTool.execute(a.c, { retention_days: 30, rationale: "retarget" });
    expect(a.emit).toHaveBeenCalledWith(
      "meta_ads.create_custom_audience",
      expect.objectContaining({ kind: "website_visitors", retention_days: 30, name: "Website visitors, 30 days" }),
    );
  });
});

describe("A F3: a launch the founder asked for keeps the founder's confirm", () => {
  const dup = { source_ad_set_id: "2220001", daily_budget_usd: 150, rationale: "scale the winner" };
  const ad = { ad_set_id: "2220001", image_url: "https://x.com/i.png", primary_text: "p", headline: "h", link_url: "https://x.com", source: "zavi_generated", rationale: "r" };
  const run = (over: Partial<ToolContext>) => {
    const a = ctx();
    Object.assign(a.c, over);
    return a;
  };
  const emitted = async (over: Partial<ToolContext>) => {
    const out: unknown[] = [];
    for (const [tool, input] of [
      [metaProposeDuplicateTool, dup],
      [metaProposeNewAdTool, ad],
      [metaProposeCustomAudienceTool, { retention_days: 30, rationale: "r" }],
    ] as const) {
      const a = run(over);
      await tool.execute(a.c, input);
      out.push(a.emit.mock.calls[0][1]);
    }
    return out as Array<Record<string, unknown>>;
  };

  it("a founder's own chat turn stamps origin user_initiated_chat on every launch body, and the dispatch schemas keep it", async () => {
    const bodies = await emitted({ run_trigger: "chat" });
    for (const b of bodies) expect(b.origin).toBe("user_initiated_chat");
    expect(duplicateAdSetBodySchema.parse(bodies[0]).origin).toBe("user_initiated_chat");
    expect(createAdBodySchema.parse(bodies[1]).origin).toBe("user_initiated_chat");
    expect(createCustomAudienceBodySchema.parse(bodies[2]).origin).toBe("user_initiated_chat");
    expect(await cgoApproveAdDecision("t-1", "d-1", "meta_ads.duplicate_ad_set", bodies[0])).toBe(false);
  });

  it("not the founder's words: a cron or CGO run, a chat turn carrying a captured page, or one only a company rule steered: no origin", async () => {
    for (const over of [
      { run_trigger: "cron" },
      { run_trigger: "chat", untrusted_context: true },
      { run_trigger: "chat", rules_steered: { budget: true, status: false } },
    ] as Array<Partial<ToolContext>>) {
      for (const b of await emitted(over)) expect(b.origin, JSON.stringify(over)).toBeUndefined();
    }
  });

  it("the model cannot set it: an origin in the tool input is dropped", async () => {
    const a = run({ run_trigger: "cron" });
    await metaProposeDuplicateTool.execute(a.c, { ...dup, origin: "user_initiated_chat" });
    expect((a.emit.mock.calls[0][1] as Record<string, unknown>).origin).toBeUndefined();
  });
});

describe("shapes: live, tagged, and the tag survives a clamp", () => {
  it("a copy is shallow (its ads go in on their own creatives: a deep copy rewrites them), made PAUSED, renamed with the action's tag", () => {
    const tag = launchTag("aaaaaaaa-1111-4222-8333-444455556666");
    expect(tag).toBe("zvaaaaaaaa11");
    expect(shapeCopyAdSetRequest({ source_ad_set_id: "2220001", tag })).toEqual({
      path: "2220001/copies",
      params: { deep_copy: "false", status_option: "PAUSED", rename_options: JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` · ${tag}` }) },
    });
    expect(shapeCopyAdSetRequest({ source_ad_set_id: "2220001", tag, campaign_id: "3330001", rename: "none" }).params).toEqual({
      deep_copy: "false",
      status_option: "PAUSED",
      rename_options: JSON.stringify({ rename_strategy: "NO_RENAME" }),
      campaign_id: "3330001",
    });
    const long = taggedName("x".repeat(300), tag);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(nameHasTag(long, tag)).toBe(true);
  });

  it("the ad is ACTIVE; the budget is account minor units (cents, paise); an unverified currency is refused", () => {
    expect(shapeLaunchAdRequest({ ad_account_id: "act_1", ad_set_id: "2220001", creative_id: "12345", name: "n" }).params.status).toBe("ACTIVE");
    expect(shapeSetDailyBudgetRequest({ object_id: "2220001", daily_budget_usd: 12.5 }, "USD").params.daily_budget).toBe("1250");
    expect(shapeSetDailyBudgetRequest({ object_id: "2220001", daily_budget_usd: 1500 }, "INR").params.daily_budget).toBe("150000");
    expect(() => shapeSetDailyBudgetRequest({ object_id: "2220001", daily_budget_usd: 12.5 }, "EUR")).toThrow(/USD and INR ad accounts/);
  });

  it("a video creative needs a thumbnail; an image goes by URL; the click carries the tag", () => {
    const base = { ad_account_id: "act_1", page_id: "77", name: "n", primary_text: "p", headline: "h", link_url: "https://x.com", cta: "LEARN_MORE" as const, tag: "zv1234567890" };
    expect(() => shapeLaunchCreativeRequest({ ...base, video_id: "999" })).toThrow(/thumbnail/);
    const img = shapeLaunchCreativeRequest({ ...base, image_url: "https://x.com/i.png" });
    expect(JSON.parse(img.params.object_story_spec).link_data.picture).toBe("https://x.com/i.png");
    expect(img.params.url_tags).toContain("utm_campaign=zv1234567890");
  });

  it("a website audience: the pixel, the window in seconds, back-filled", () => {
    const r = shapeWebsiteAudienceRequest({ ad_account_id: "act_1", pixel_id: "5550001", retention_days: 90, name: "n" });
    expect(r.path).toBe("act_1/customaudiences");
    expect(r.params.prefill).toBe("true");
    expect(JSON.parse(r.params.rule).inclusions.rules[0]).toMatchObject({ event_sources: [{ id: "5550001", type: "pixel" }], retention_seconds: 90 * 86400 });
  });

  it("reads a copy answer's new id and its children", () => {
    expect(readCopyResult({ copied_adset_id: "9", ad_object_ids: [{ ad_object_type: "ad", source_id: "1", copied_id: "2" }] }, "adset")).toEqual({
      copied_id: "9",
      children: [{ type: "ad", source_id: "1", copied_id: "2" }],
    });
    expect(readCopyResult({}, "campaign").copied_id).toBeNull();
  });
});

describe("cards, rail and the unattended allowlist", () => {
  it("each class draws an exact-change card from the parsed body, and an unparseable body draws none", () => {
    expect(metaChangeRows("meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 75 })?.rows).toContainEqual({
      item: "Daily budget",
      before: "None",
      after: "$75/day",
    });
    expect(metaChangeRows("meta_ads.duplicate_ad_set", { source_ad_set_id: "x", daily_budget_usd: 75 })).toBeNull();
    expect(metaChangeRows("meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 90 })?.title).toMatch(/90 days/);
    expect(metaExecActionType("meta_ads.duplicate_ad_set", {})).toBe("create_ad");
    expect(metaExecActionType("meta_ads.create_ad", {})).toBe("create_ad");
  });

  it("the four classes are create-shaped on the allowlist, under the same create rules", () => {
    const facts = { refsResolved: true, openAdvice: "clear" as const, goal: { present: false as const }, channelAutorun: true };
    const bodies: Record<string, unknown> = {
      "meta_ads.duplicate_ad_set": { source_ad_set_id: "2220001", daily_budget_usd: 50 },
      "meta_ads.duplicate_campaign": { source_campaign_id: "1110001", daily_budget_usd: 50 },
      "meta_ads.create_ad": { ad_set_id: "2220001", image_url: "https://x.com/i.png", primary_text: "p", headline: "h", link_url: "https://x.com", source: "zavi_generated" },
      "meta_ads.create_custom_audience": { kind: "website_visitors", retention_days: 30, name: "Website visitors, 30 days" },
    };
    for (const [cls, payload] of Object.entries(bodies)) {
      expect(adShape(cls, payload)).toEqual({ cls: "create", platform: "meta", missingLocation: false });
      const action = { kind: "ad" as const, exec_class: cls, payload, source: { table: "channel_actions" as const, id: "a", run_id: null } };
      expect(evaluateUnattended(action, facts)).toEqual({ verdict: "allow", reasons: [] });
      expect(evaluateUnattended(action, { ...facts, openAdvice: "conflict" }).verdict).toBe("ask_founder");
      expect(evaluateUnattended(action, { ...facts, channelAutorun: false })).toEqual({ verdict: "ask_founder", reasons: ["channel_asks_first"] });
      expect(evaluateUnattended(action, { ...facts, channelAutorun: null })).toEqual({ verdict: "ask_founder", reasons: ["autorun_unreadable"] });
    }
  });

  it("only the spend-from-zero copies may skip the cap on a founder's own approval", () => {
    expect(ADS_CAP_BYPASS_CLASSES.has("meta_ads.duplicate_ad_set")).toBe(true);
    expect(ADS_CAP_BYPASS_CLASSES.has("meta_ads.duplicate_campaign")).toBe(true);
    expect(ADS_CAP_BYPASS_CLASSES.has("meta_ads.create_ad")).toBe(false);
  });
});

describe("migration 20261012110200: approval-only, never auto, mirrored in the worker", () => {
  const root = join(__dirname, "..", "..", "..", "..", "..", "..", "..", "..");
  const sql = readFileSync(join(root, "supabase", "migrations", "20261012110200_meta_ads_launch_classes.sql"), "utf8");
  const worker = readFileSync(join(root, "apps", "backend", "workers", "functions", "dispatch-decision.ts"), "utf8");
  const neverAuto = worker.slice(worker.indexOf("export const NEVER_AUTO_DECISION_CLASSES"), worker.indexOf("]);", worker.indexOf("export const NEVER_AUTO_DECISION_CLASSES")));
  for (const cls of ["meta_ads.duplicate_ad_set", "meta_ads.duplicate_campaign", "meta_ads.create_ad", "meta_ads.create_custom_audience"]) {
    it(`${cls}: seeded approval + never_auto + not allowlistable, handler wired, layer-3 mirror`, () => {
      const line = sql.split("\n").find((l) => l.includes(`('${cls}',`)) ?? "";
      expect(line).toMatch(new RegExp(`'approval', '${cls.replace(".", "\\.")}', true, false, '(high|medium|low)'\\),?$`));
      expect(neverAuto).toContain(`"${cls}",`);
      expect(worker).toContain(`"${cls}": async (d) => {`);
    });
  }
});
