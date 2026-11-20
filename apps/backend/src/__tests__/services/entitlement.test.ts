
import { describe, it, expect, vi, beforeEach } from "vitest";

let configBlob: Record<string, unknown> | null = null;
let configErr: { message: string } | null = null;
let subRow: { tier: string | null; status: string } | null = null;
let subErr: { message: string } | null = null;
let buildRow: { id: string } | null = null;
let buildErr: { message: string } | null = null;
const reads: string[] = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      reads.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            table === "system_config"
              ? { data: configErr ? null : { blob: configBlob }, error: configErr }
              : table === "conductor_runs"
                ? { data: buildErr ? null : buildRow, error: buildErr }
                : { data: subErr ? null : subRow, error: subErr },
          ),
      };
      return chain;
    },
  }),
}));

import {
  annotateLockedTier,
  checkAgentTier,
  createTierGate,
  filterPlanEntitledAgents,
  isLiveBuildStage,
  loadTierGateConfig,
  notePlanWallMap,
  planUpgradeErrorBody,
  planWallMessage,
  planUpgradeMessage,
  requiredTierFromDbError,
} from "@/services/agents/entitlement";
import { FREE_EVERY_PLAN_SENTENCE } from "@/services/billing/plan-summary";
import { DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO } from "@/services/billing/tiers";

const T = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  configBlob = { tier_gate_enforced: true };
  configErr = null;
  subRow = null;
  subErr = null;
  buildRow = null;
  buildErr = null;
  reads.length = 0;
  notePlanWallMap(DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO);
});

describe("checkAgentTier", () => {
  it("gate off ⇒ everything allowed, no subscription read", async () => {
    configBlob = { tier_gate_enforced: false };
    const d = await checkAgentTier(T, "browser-operator");
    expect(d).toMatchObject({ enforced: false, allowed: true, required_tier: "starter" });
    expect(reads).toEqual(["system_config"]);
  });

  it("string 'true' does not turn the gate on", async () => {
    configBlob = { tier_gate_enforced: "true" };
    expect((await checkAgentTier(T, "performance-marketer")).allowed).toBe(true);
  });

  it("no subscription row ⇒ free: operator allowed, seo + engineer refused", async () => {
    expect((await checkAgentTier(T, "operator")).allowed).toBe(true);
    expect(await checkAgentTier(T, "seo")).toMatchObject({ allowed: false, tier: "free", required_tier: "starter" });
    expect(await checkAgentTier(T, "engineer")).toMatchObject({ allowed: false, required_tier: "pro" });
  });

  it("NO manual_only bypass: engineer and fundraising need pro on growth", async () => {
    subRow = { tier: "growth", status: "active" };
    expect((await checkAgentTier(T, "engineer")).allowed).toBe(false);
    expect((await checkAgentTier(T, "fundraising")).allowed).toBe(false);
    expect((await checkAgentTier(T, "seo")).allowed).toBe(true);
  });

  it("pro tier on past_due still runs premium", async () => {
    subRow = { tier: "pro", status: "past_due" };
    expect((await checkAgentTier(T, "meta_ads")).allowed).toBe(true);
  });

  it("canceled / incomplete subscription resolves to free", async () => {
    subRow = { tier: "pro", status: "canceled" };
    expect(await checkAgentTier(T, "meta_ads")).toMatchObject({ allowed: false, tier: "free" });
    subRow = { tier: "pro", status: "incomplete" };
    expect((await checkAgentTier(T, "operator")).allowed).toBe(true);
  });

  it("tier_pro_tenants forces pro without reading the subscription", async () => {
    configBlob = { tier_gate_enforced: true, tier_pro_tenants: [T] };
    expect(await checkAgentTier(T, "engineer")).toMatchObject({ allowed: true, tier: "pro" });
    expect(reads).toEqual(["system_config"]);
  });

  it("unknown agent slug needs pro (deny-by-default)", async () => {
    subRow = { tier: "growth", status: "active" };
    expect(await checkAgentTier(T, "brand-new-agent")).toMatchObject({ allowed: false, required_tier: "pro" });
  });

  it("a configured tier_agent_min replaces the default map", async () => {
    configBlob = { tier_gate_enforced: true, tier_agent_min: { seo: "free" } };
    expect((await checkAgentTier(T, "seo")).allowed).toBe(true);
    expect((await checkAgentTier(T, "operator")).allowed).toBe(false);
  });

  it("a system_config read error defers to the DB gate (app check not enforced)", async () => {
    configErr = { message: "boom" };
    subRow = { tier: null, status: "active" };
    expect(await checkAgentTier(T, "engineer")).toMatchObject({ enforced: false, allowed: true });
  });

  it("FAILS CLOSED on a subscription read error", async () => {
    subErr = { message: "connection reset" };
    await expect(checkAgentTier(T, "operator")).rejects.toThrow(/subscription read failed/);
  });
});

describe("createTierGate (per-tick memo)", () => {
  it("reads config once and each tenant once", async () => {
    subRow = { tier: "starter", status: "active" };
    const gate = createTierGate();
    await gate.decide(T, "seo");
    await gate.decide(T, "engineer");
    await gate.decide(T, "operator");
    expect(reads.filter((r) => r === "system_config")).toHaveLength(1);
    expect(reads.filter((r) => r === "tenant_subscriptions")).toHaveLength(1);
  });
});

describe("refusal shape", () => {
  it("message names the agent, plan and price", () => {
    expect(planUpgradeMessage("meta_ads", "pro")).toBe("Meta Ads needs the Pro plan ($240/mo).");
    expect(planUpgradeMessage("engineer", "pro")).toBe("Engineer needs the Pro plan ($240/mo).");
    expect(planUpgradeMessage("growth-lead", "starter")).toBe("Growth Lead needs the Starter plan ($20/mo).");
  });

  it("403 body matches the contract exactly", () => {
    expect(planUpgradeErrorBody("meta_ads", "pro")).toEqual({
      error: {
        code: "plan_upgrade_required",
        required_tier: "pro",
        message: `Meta Ads needs the Pro plan ($240/mo). ${FREE_EVERY_PLAN_SENTENCE}`,
      },
    });
  });

  it("the wall names the plan needed and lists what Free can do", () => {
    const m = planWallMessage("instagram_organic", "starter");
    expect(m.startsWith("Instagram needs the Starter plan ($20/mo).")).toBe(true);
    expect(m).toContain("Free included");
    expect(m).toContain("post images");
  });

  it("required tier comes from the DB error details, pro when missing/garbage", () => {
    expect(requiredTierFromDbError({ details: "starter" })).toBe("starter");
    expect(requiredTierFromDbError({ details: " growth " })).toBe("growth");
    expect(requiredTierFromDbError({ details: null })).toBe("pro");
    expect(requiredTierFromDbError({ details: "platinum" })).toBe("pro");
    expect(requiredTierFromDbError(null)).toBe("pro");
  });
});

describe("listings", () => {
  const agents = [{ slug: "operator" }, { slug: "seo" }, { slug: "engineer" }];

  it("annotateLockedTier keeps every agent and sets locked_tier", async () => {
    subRow = { tier: "starter", status: "active" };
    expect(await annotateLockedTier(agents, T)).toEqual([
      { slug: "operator", locked_tier: null },
      { slug: "seo", locked_tier: null },
      { slug: "engineer", locked_tier: "pro" },
    ]);
  });

  it("annotateLockedTier: gate off ⇒ only the channel and the Pro-page agent are locked", async () => {
    configBlob = {};
    expect((await annotateLockedTier(agents, T)).map((a) => a.locked_tier)).toEqual([null, "starter", "pro"]);
    subRow = { tier: "pro", status: "active" };
    expect((await annotateLockedTier(agents, T)).map((a) => a.locked_tier)).toEqual([null, null, null]);
  });

  it("annotateLockedTier: gate off and no always-gated agent ⇒ no subscription read", async () => {
    configBlob = {};
    await annotateLockedTier([{ slug: "operator" }, { slug: "browser-operator" }], T);
    expect(reads).toEqual(["system_config"]);
  });

  it("annotateLockedTier never throws (display only), and says the plan was unknown", async () => {
    configErr = { message: "down" };
    const onReadError = vi.fn();
    expect((await annotateLockedTier(agents, T, onReadError)).map((a) => a.locked_tier)).toEqual([null, null, null]);
    expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("annotateLockedTier does not report a read error when the plan was read", async () => {
    const onReadError = vi.fn();
    await annotateLockedTier(agents, T, onReadError);
    expect(onReadError).not.toHaveBeenCalled();
  });

  it("filterPlanEntitledAgents drops locked agents when enforced, throws on a subscription read error", async () => {
    expect((await filterPlanEntitledAgents(agents, T)).map((a) => a.slug)).toEqual(["operator"]);
    subErr = { message: "down" };
    await expect(filterPlanEntitledAgents(agents, T)).rejects.toThrow();
  });
});

describe("Pro-page agents: gated to Pro even with the switch off", () => {
  const PAGES = ["engineer", "fundraising", "supply-demand-balancer"];

  beforeEach(() => {
    configBlob = { tier_gate_enforced: false };
  });

  it("free and growth are refused, other Pro agents still run", async () => {
    for (const slug of PAGES) {
      expect(await checkAgentTier(T, slug)).toMatchObject({ enforced: true, allowed: false, required_tier: "pro" });
    }
    subRow = { tier: "growth", status: "active" };
    for (const slug of PAGES) expect((await checkAgentTier(T, slug)).allowed).toBe(false);
    expect((await checkAgentTier(T, "performance-marketer")).allowed).toBe(true);
  });

  it("pro, and the tier_pro_tenants dogfood list, may run them", async () => {
    subRow = { tier: "pro", status: "active" };
    for (const slug of PAGES) expect((await checkAgentTier(T, slug)).allowed).toBe(true);
    subRow = null;
    configBlob = { tier_gate_enforced: false, tier_pro_tenants: [T] };
    for (const slug of PAGES) expect((await checkAgentTier(T, slug)).allowed).toBe(true);
  });

  it("no tier_agent_min edit can lower them", async () => {
    configBlob = { tier_gate_enforced: true, tier_agent_min: { engineer: "free", "supply-demand-balancer": "free" } };
    expect(await checkAgentTier(T, "engineer")).toMatchObject({ allowed: false, required_tier: "pro" });
    expect(await checkAgentTier(T, "supply-demand-balancer")).toMatchObject({ allowed: false, required_tier: "pro" });
  });

  it("a Build stage is priced as product-builder, with the switch off AND on", async () => {
    expect((await checkAgentTier(T, "engineer", { buildStage: true })).allowed).toBe(true);
    expect((await checkAgentTier(T, "fundraising", { buildStage: true })).allowed).toBe(false);
    expect((await checkAgentTier(T, "supply-demand-balancer", { buildStage: true })).allowed).toBe(false);

    configBlob = { tier_gate_enforced: true };
    subRow = { tier: "starter", status: "active" };
    expect(await checkAgentTier(T, "engineer", { buildStage: true })).toMatchObject({
      enforced: true,
      required_tier: "starter",
      allowed: true,
    });
    subRow = null;
    expect((await checkAgentTier(T, "engineer", { buildStage: true })).allowed).toBe(false);
    subRow = { tier: "starter", status: "active" };
    expect(await checkAgentTier(T, "engineer")).toMatchObject({ required_tier: "pro", allowed: false });
  });

  it("a server-started engineer run is allowed on free, with the switch off AND on", async () => {
    subRow = null;
    configBlob = { tier_gate_enforced: false };
    expect((await checkAgentTier(T, "engineer", { engineerBackendRun: true })).allowed).toBe(true);
    configBlob = { tier_gate_enforced: true };
    expect((await checkAgentTier(T, "engineer", { engineerBackendRun: true })).allowed).toBe(true);
    configBlob = { tier_gate_enforced: false };
    expect(await checkAgentTier(T, "engineer", { engineerBackendRun: false })).toMatchObject({
      allowed: false,
      required_tier: "pro",
    });
    expect((await checkAgentTier(T, "fundraising", { engineerBackendRun: true })).allowed).toBe(false);
  });

  it("fails closed on a subscription read error", async () => {
    subErr = { message: "connection reset" };
    await expect(checkAgentTier(T, "fundraising")).rejects.toThrow(/subscription read failed/);
  });

  it("refuses fundraising on starter ($20) and growth ($120)", async () => {
    for (const tier of ["starter", "growth"]) {
      subRow = { tier, status: "active" };
      expect(await checkAgentTier(T, "fundraising"), `${tier} should not reach fundraising`).toMatchObject({
        tier,
        required_tier: "pro",
        allowed: false,
      });
    }
  });

  it("locks all three in the sidebar listing and nothing else", async () => {
    subRow = null;
    expect(
      await annotateLockedTier([{ slug: "fundraising" }, { slug: "engineer" }, { slug: "operator" }], T),
    ).toEqual([
      { slug: "fundraising", locked_tier: "pro" },
      { slug: "engineer", locked_tier: "pro" },
      { slug: "operator", locked_tier: null },
    ]);
  });

  it("reads no subscription when the list holds no Pro-page agent", async () => {
    await annotateLockedTier([{ slug: "operator" }], T);
    expect(reads).toEqual(["system_config"]);
  });

  it("filterPlanEntitledAgents drops them below Pro", async () => {
    const agents = [{ slug: "operator" }, { slug: "performance-marketer" }, { slug: "engineer" }];
    expect((await filterPlanEntitledAgents(agents, T)).map((a) => a.slug)).toEqual(["operator", "performance-marketer"]);
  });
});

describe("isLiveBuildStage", () => {
  const C = "22222222-2222-2222-2222-222222222222";

  it("true only when the conductor row is found", async () => {
    buildRow = { id: C };
    expect(await isLiveBuildStage(T, C)).toBe(true);
    buildRow = null;
    expect(await isLiveBuildStage(T, C)).toBe(false);
  });

  it("no id ⇒ false without a read", async () => {
    expect(await isLiveBuildStage(T, null)).toBe(false);
    expect(reads).toEqual([]);
  });

  it("a read error ⇒ false (the run is gated)", async () => {
    buildErr = { message: "down" };
    expect(await isLiveBuildStage(T, C)).toBe(false);
  });
});

describe("growth channels: gated by tier even with the switch off", () => {
  beforeEach(() => {
    configBlob = { tier_gate_enforced: false };
  });

  it("free is refused every channel; each channel names its own tier", async () => {
    expect(await checkAgentTier(T, "seo")).toMatchObject({ enforced: true, allowed: false, required_tier: "starter" });
    expect(await checkAgentTier(T, "instagram_organic")).toMatchObject({ allowed: false, required_tier: "starter" });
    expect(await checkAgentTier(T, "chatgpt_ads")).toMatchObject({ allowed: false, required_tier: "pro" });
    expect((await checkAgentTier(T, "operator")).allowed).toBe(true);
  });

  it("starter gets every organic channel; ads stay pro", async () => {
    subRow = { tier: "starter", status: "active" };
    for (const s of ["seo", "geo", "linkedin_organic", "x_organic", "reddit_organic", "instagram_organic"]) {
      expect((await checkAgentTier(T, s)).allowed).toBe(true);
    }
    expect((await checkAgentTier(T, "meta_ads")).allowed).toBe(false);
    subRow = { tier: "growth", status: "active" };
    expect((await checkAgentTier(T, "meta_ads")).allowed).toBe(false);
    subRow = { tier: "pro", status: "active" };
    expect((await checkAgentTier(T, "chatgpt_ads")).allowed).toBe(true);
  });

  it("tier_agent_min can open a channel to every plan", async () => {
    configBlob = { tier_gate_enforced: false, tier_agent_min: { seo: "free" } };
    expect((await checkAgentTier(T, "seo")).allowed).toBe(true);
  });

  it("a config read error defers to the DB gate", async () => {
    configErr = { message: "down" };
    expect(await checkAgentTier(T, "seo")).toMatchObject({ enforced: false, allowed: true });
  });
});

describe("planWallMessage follows the live map", () => {
  beforeEach(() => {
    configErr = null;
  });

  it("drops the every-plan sentence once the live map moves operator off Free, and restores it", async () => {
    configBlob = { tier_agent_min: { operator: "starter" } };
    await loadTierGateConfig();
    expect(planWallMessage("meta_ads", "pro")).toBe(planUpgradeMessage("meta_ads", "pro"));
    expect(planUpgradeErrorBody("meta_ads", "pro").error.message).not.toContain(FREE_EVERY_PLAN_SENTENCE);

    configBlob = {};
    await loadTierGateConfig();
    expect(planWallMessage("meta_ads", "pro")).toContain(FREE_EVERY_PLAN_SENTENCE);
  });

  it("a failed config read leaves the sentence out rather than promise a stale map", async () => {
    configBlob = {};
    await loadTierGateConfig();
    configErr = { message: "down" };
    await loadTierGateConfig();
    expect(planWallMessage("meta_ads", "pro")).toBe(planUpgradeMessage("meta_ads", "pro"));
  });
});
