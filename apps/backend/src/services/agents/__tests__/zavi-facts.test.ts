import { beforeEach, describe, expect, it, vi } from "vitest";

let configBlob: Record<string, unknown> | null = null;
let configErr: { message: string } | null = null;
let subRow: { tier: string | null; status: string | null; comp_expires_at: string | null } | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          table === "system_config"
            ? { data: configErr ? null : { blob: configBlob }, error: configErr }
            : { data: subRow, error: null },
      };
      return chain;
    },
  }),
}));

import {
  DEFAULT_TIER_AGENT_MIN,
  DEFAULT_TIER_ALWAYS_PRO,
  DEFAULT_TIER_CREDITS,
  TIER_PRICE_USD,
  type Tier,
} from "@/services/billing/tiers";
import { FREE_EVERY_PLAN_SENTENCE, freePlanSummary } from "@/services/billing/plan-summary";
import { buildZaviFactsBlock, loadZaviFactsBlock, type ZaviFactsInput } from "@/services/agents/zavi-facts";

function input(over: Partial<ZaviFactsInput> = {}): ZaviFactsInput {
  return {
    agentMin: DEFAULT_TIER_AGENT_MIN,
    alwaysPro: DEFAULT_TIER_ALWAYS_PRO,
    credits: DEFAULT_TIER_CREDITS,
    freeDailyCredits: 1000,
    lockedChannels: new Set(),
    configRead: true,
    tenantTier: null,
    ...over,
  };
}

function planLine(block: string, name: string): string {
  return block.split("\n").find((l) => l.startsWith(`- ${name} (`)) ?? "";
}

describe("buildZaviFactsBlock", () => {
  it("romeo-m: knows Zavi support's email", () => {
    expect(buildZaviFactsBlock(input())).toContain("support@zaviagent.com");
  });

  it("distinguishes cancelling a paid plan from deleting an account", () => {
    const b = buildZaviFactsBlock(input());
    expect(b).toContain("Settings → Billing → Cancel plan");
    expect(b).toContain("App Store or Google Play");
    expect(b).toContain("Account → Delete account");
    expect(b).toContain("https://www.zaviagent.com/account");
    expect(b).toContain("Deleting an account does not cancel a workspace's paid plan");
    expect(b).toContain("ask which they mean");
  });

  it("phnmpenhgolf: knows tutorials exist and where", () => {
    const b = buildZaviFactsBlock(input());
    expect(b).toContain("https://www.zaviagent.com/tutorials");
    expect(b).toContain("How to use Zavi");
  });

  it("royal-keita: lists every plan with its price and what Free can do", () => {
    const b = buildZaviFactsBlock(input());
    expect(planLine(b, "Free")).toContain(FREE_EVERY_PLAN_SENTENCE.slice(0, -1));
    expect(planLine(b, "Free")).toContain("Growth plan");
    expect(planLine(b, "Free")).toContain("Research reports");
    expect(planLine(b, "Starter")).toContain(`$${TIER_PRICE_USD.starter}/mo`);
    expect(planLine(b, "Growth")).toContain(`$${TIER_PRICE_USD.growth}/mo`);
    expect(planLine(b, "Pro")).toContain(`$${TIER_PRICE_USD.pro}/mo`);
    expect(planLine(b, "Starter")).toContain("Instagram");
    expect(planLine(b, "Pro")).toContain("Meta Ads");
    expect(planLine(b, "Pro")).toContain("Engineer page");
    expect(b).toContain("1,000 free credits a day");
  });

  it("is generated from the tier map: moving a channel moves it in the text", () => {
    const moved: Record<string, Tier> = { ...DEFAULT_TIER_AGENT_MIN, instagram_organic: "pro" };
    const b = buildZaviFactsBlock(input({ agentMin: moved }));
    expect(planLine(b, "Starter")).not.toContain("Instagram");
    expect(planLine(b, "Pro")).toContain("Instagram");
  });

  it("the every-plan sentence is dropped when the live map takes chat off Free", () => {
    const moved: Record<string, Tier> = { ...DEFAULT_TIER_AGENT_MIN, operator: "starter" };
    expect(freePlanSummary(moved)).not.toContain("chat with Zavi");
    const researchMoved: Record<string, Tier> = { ...DEFAULT_TIER_AGENT_MIN, research: "starter" };
    expect(freePlanSummary(researchMoved)).not.toContain("Research reports");
  });

  it("a channel moved to Free is named in the Free line", () => {
    const moved: Record<string, Tier> = { ...DEFAULT_TIER_AGENT_MIN, blog: "free" };
    expect(freePlanSummary(moved)).toContain("Blog");
    expect(planLine(buildZaviFactsBlock(input({ agentMin: moved })), "Free")).toContain("Blog");
  });

  it("marks a locked channel coming soon and leaves plumbing agents out", () => {
    const b = buildZaviFactsBlock(input({ lockedChannels: new Set(["chatgpt_ads"]) }));
    expect(planLine(b, "Pro")).toContain("ChatGPT Ads (coming soon)");
    expect(b).not.toMatch(/\bOperator\b|Onboarding Discovery|Content Seo/);
  });

  it("says the workspace's plan only when it was read", () => {
    expect(buildZaviFactsBlock(input({ tenantTier: "starter" }))).toContain("This workspace is on the Starter plan.");
    expect(buildZaviFactsBlock(input())).not.toContain("This workspace is on");
  });

  it("leaves the daily number out rather than guess it", () => {
    const b = buildZaviFactsBlock(input({ freeDailyCredits: null }));
    expect(b).toContain("free daily credits");
    expect(b).not.toMatch(/\d[\d,]* free credits a day/);
  });
});

describe("loadZaviFactsBlock", () => {
  beforeEach(() => {
    configBlob = null;
    configErr = null;
    subRow = null;
  });

  it("reads the live daily grant and the tenant's plan", async () => {
    configBlob = { free_daily_credits: 5000 };
    subRow = { tier: "growth", status: "active", comp_expires_at: null };
    const b = await loadZaviFactsBlock("t1");
    expect(b).toContain("5,000 free credits a day");
    expect(b).toContain("This workspace is on the Growth plan.");
  });

  it("a config read failure keeps the fixed facts and does not list plan contents from defaults", async () => {
    configErr = { message: "boom" };
    const b = await loadZaviFactsBlock("t1");
    expect(b).toContain("support@zaviagent.com");
    expect(b).toContain("Settings → Billing → Cancel plan");
    expect(b).toContain("https://www.zaviagent.com/account");
    expect(b).toContain(`Pro ($${TIER_PRICE_USD.pro}/mo)`);
    expect(b).not.toContain("Meta Ads");
    expect(b).not.toMatch(/credits a month/);
    expect(b).not.toMatch(/\d[\d,]* free credits a day/);
  });

  it("names the plan the workspace pays for, not a Pro feature override", async () => {
    configBlob = { tier_pro_tenants: ["t1"] };
    subRow = null;
    const b = await loadZaviFactsBlock("t1");
    expect(b).toContain("This workspace is on the Free plan.");
    expect(b).not.toContain("This workspace is on the Pro plan.");
  });
});
