
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "@zavi/shared";
import {
  DEFAULT_TIER_AGENT_MIN,
  DEFAULT_TIER_CREDITS,
  PLAN_UPGRADE_REQUIRED,
  TIERS,
  buildConductorRunIdOf,
  isPaidTier,
  isPlanUpgradeError,
  isProPageAgent,
  isTier,
  requiredTierFor,
  tierAgentMinFromBlob,
  tierAllows,
  tierAlwaysProFromBlob,
  tierConfigRejection,
  tierCreditsFromBlob,
  tierGateEnforcedFromBlob,
  tierProTenantsFromBlob,
  tierRank,
  isTierGatedChannel,
} from "../tiers";

const SRC = join(__dirname, "..", "..", "..");
const REPO = join(SRC, "..", "..", "..");

describe("parity: every agent + channel is classified", () => {
  it("every agent directory (with an agent.md) is in DEFAULT_TIER_AGENT_MIN", () => {
    const agentsDir = join(SRC, "agents");
    const excluded = new Set(["_core", "lib", "__tests__"]);
    const dirs = readdirSync(agentsDir).filter((d) => {
      if (excluded.has(d)) return false;
      const full = join(agentsDir, d);
      return statSync(full).isDirectory() && existsSync(join(full, "agent.md"));
    });
    expect(dirs.length).toBeGreaterThan(10);
    const missing = dirs.filter((d) => !(d in DEFAULT_TIER_AGENT_MIN));
    expect(missing).toEqual([]);
  });

  it("every registry channel is in DEFAULT_TIER_AGENT_MIN (slug and executor)", () => {
    const missing = CHANNELS.flatMap((c) => [c.slug, c.executor]).filter(
      (s) => !(s in DEFAULT_TIER_AGENT_MIN),
    );
    expect(missing).toEqual([]);
  });

  it("the plan's matrix: premium channels + the Pro-page agents are pro", () => {
    for (const s of [
      "engineer",
      "fundraising",
      "supply-demand-balancer",
      "google_ads",
      "meta_ads",
      "tiktok_ads",
      "linkedin_ads",
      "reddit_ads",
      "youtube_ads",
      "chatgpt_ads",
      "email_marketing",
      "sms",
    ]) {
      expect(DEFAULT_TIER_AGENT_MIN[s]).toBe("pro");
    }
    for (const s of ["seo", "geo", "linkedin_organic", "reddit_organic", "x_organic", "instagram_organic"]) {
      expect(DEFAULT_TIER_AGENT_MIN[s]).toBe("starter");
    }
    for (const s of ["tiktok_organic", "youtube_organic", "ugc"]) {
      expect(DEFAULT_TIER_AGENT_MIN[s]).toBe("growth");
    }
    for (const s of ["operator", "research", "advisor", "cgo", "growth-lead", "pm", "chief-of-staff", "support-lead", "qa", "dispute-response"]) {
      expect(DEFAULT_TIER_AGENT_MIN[s]).toBe("free");
    }
  });

  it("SQL _tier_agent_min_default() equals DEFAULT_TIER_AGENT_MIN", () => {
    const migDir = join(REPO, "supabase", "migrations");
    const file = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        readFileSync(join(migDir, f), "utf8").includes("create or replace function _tier_agent_min_default"),
      )
      .sort()
      .at(-1);
    expect(file).toBeTruthy();
    const sql = readFileSync(join(migDir, file!), "utf8");
    const m = sql.match(/_tier_agent_min_default\(\)[\s\S]*?select '(\{[\s\S]*?\})'::jsonb/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m![1])).toEqual(DEFAULT_TIER_AGENT_MIN);
  });

  it("SQL _tier_channel_gated() lists exactly the registry channels", () => {
    const migDir = join(REPO, "supabase", "migrations");
    const file = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        readFileSync(join(migDir, f), "utf8").includes("create or replace function _tier_channel_gated"),
      )
      .sort()
      .at(-1);
    expect(file).toBeTruthy();
    const sql = readFileSync(join(migDir, file!), "utf8");
    const m = sql.match(/_tier_channel_gated\(p_slug text\)[\s\S]*?p_slug in \(([^)]*)\)/);
    expect(m).toBeTruthy();
    const slugs = [...m![1].matchAll(/'([a-z0-9_-]+)'/g)].map((x) => x[1]).sort();
    expect(slugs).toEqual(CHANNELS.map((c) => c.slug).sort());
    for (const c of CHANNELS) expect(isTierGatedChannel(c.executor)).toBe(true);
    expect(isTierGatedChannel("engineer")).toBe(false);
    expect(isTierGatedChannel("performance-marketer")).toBe(false);
  });

  it("SQL tier_credits seed + fallbacks equal DEFAULT_TIER_CREDITS", () => {
    const migDir = join(REPO, "supabase", "migrations");
    const sql = readFileSync(join(migDir, "20260917190000_three_tier_pricing.sql"), "utf8");
    expect(sql).toContain(`'tier_credits',       '${JSON.stringify(DEFAULT_TIER_CREDITS)}'::jsonb`);
    expect(sql).toContain(
      `when 'starter' then ${DEFAULT_TIER_CREDITS.starter} when 'growth' then ${DEFAULT_TIER_CREDITS.growth} when 'pro' then ${DEFAULT_TIER_CREDITS.pro}`,
    );
  });
});

describe("tier helpers", () => {
  it("ranks free < starter < growth < pro", () => {
    expect(TIERS.map(tierRank)).toEqual([0, 1, 2, 3]);
  });

  it("isTier / isPaidTier", () => {
    expect(isTier("growth")).toBe(true);
    expect(isTier("team")).toBe(false);
    expect(isTier(null)).toBe(false);
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("pro")).toBe(true);
  });

  it("requiredTierFor: unknown ⇒ pro; invalid map value ⇒ pro", () => {
    expect(requiredTierFor("operator")).toBe("free");
    expect(requiredTierFor("nope")).toBe("pro");
    expect(requiredTierFor("x", { x: "gold" as never })).toBe("pro");
  });

  it("requiredTierFor: a Pro-page agent is pro whatever the map says", () => {
    for (const s of ["engineer", "fundraising", "supply-demand-balancer"]) {
      expect(isProPageAgent(s)).toBe(true);
      expect(requiredTierFor(s, { [s]: "free" })).toBe("pro");
    }
    expect(isProPageAgent("product-builder")).toBe(false);
  });

  it("tier_always_pro: absent or junk keeps today's list; an array replaces it", () => {
    expect(tierAlwaysProFromBlob(null)).toEqual(["engineer", "fundraising", "supply-demand-balancer"]);
    expect(tierAlwaysProFromBlob({ tier_always_pro: "engineer" })).toEqual([
      "engineer",
      "fundraising",
      "supply-demand-balancer",
    ]);
    expect(tierAlwaysProFromBlob({ tier_always_pro: ["fundraising", 7, "Bad Slug"] })).toEqual(["fundraising"]);
    expect(tierAlwaysProFromBlob({ tier_always_pro: [] })).toEqual([]);
  });

  it("engineer follows tier_agent_min once it is off the always-Pro list", () => {
    const alwaysPro = tierAlwaysProFromBlob({ tier_always_pro: ["fundraising", "supply-demand-balancer"] });
    const map = { ...DEFAULT_TIER_AGENT_MIN, engineer: "free" as const };
    expect(requiredTierFor("engineer", map, alwaysPro)).toBe("free");
    expect(tierAllows("free", "engineer", map, alwaysPro)).toBe(true);
    expect(requiredTierFor("fundraising", { ...map, fundraising: "free" }, alwaysPro)).toBe("pro");
    expect(requiredTierFor("engineer", map)).toBe("pro");
  });

  it("tierConfigRejection: tier_always_pro must be an array of slugs", () => {
    expect(tierConfigRejection("tier_always_pro", ["fundraising"])).toBeNull();
    expect(tierConfigRejection("tier_always_pro", ["chatgpt_ads", "email_marketing"])).toBeNull();
    expect(tierAlwaysProFromBlob({ tier_always_pro: ["chatgpt_ads"] })).toEqual(["chatgpt_ads"]);
    expect(tierConfigRejection("tier_always_pro", [])).toBeNull();
    expect(tierConfigRejection("tier_always_pro", "engineer")).toMatch(/array of agent slugs/);
    expect(tierConfigRejection("tier_always_pro", ["Engineer!"])).toMatch(/array of agent slugs/);
  });

  it("buildConductorRunIdOf reads only a well-formed uuid", () => {
    const id = "22222222-2222-2222-2222-22222222ABCD";
    expect(buildConductorRunIdOf({ build_conductor_run_id: id })).toBe(id.toLowerCase());
    expect(buildConductorRunIdOf({ build_conductor_run_id: "-".repeat(36) })).toBeNull();
    expect(buildConductorRunIdOf({ build_conductor_run_id: 7 })).toBeNull();
    expect(buildConductorRunIdOf(null)).toBeNull();
  });

  it("tierAllows follows the rank", () => {
    expect(tierAllows("starter", "seo")).toBe(true);
    expect(tierAllows("free", "seo")).toBe(false);
    expect(tierAllows("growth", "meta_ads")).toBe(false);
    expect(tierAllows("pro", "meta_ads")).toBe(true);
    expect(tierAllows("pro", "never-heard-of-it")).toBe(true);
  });

  it("tierCreditsFromBlob falls back per tier on malformed values", () => {
    expect(tierCreditsFromBlob(null)).toEqual(DEFAULT_TIER_CREDITS);
    expect(tierCreditsFromBlob({ tier_credits: { starter: "9000", growth: -1, pro: "1e9" } })).toEqual({
      starter: 9000,
      growth: DEFAULT_TIER_CREDITS.growth,
      pro: DEFAULT_TIER_CREDITS.pro,
    });
    expect(tierCreditsFromBlob({ tier_credits: [1, 2] })).toEqual(DEFAULT_TIER_CREDITS);
  });

  it("tierAgentMinFromBlob replaces wholesale and drops invalid values", () => {
    expect(tierAgentMinFromBlob(undefined)).toEqual(DEFAULT_TIER_AGENT_MIN);
    expect(tierAgentMinFromBlob({ tier_agent_min: "oops" })).toEqual(DEFAULT_TIER_AGENT_MIN);
    expect(tierAgentMinFromBlob({ tier_agent_min: { a: "free", b: "gold" } })).toEqual({ a: "free" });
  });

  it("tierGateEnforcedFromBlob: only literal true", () => {
    expect(tierGateEnforcedFromBlob({ tier_gate_enforced: true })).toBe(true);
    expect(tierGateEnforcedFromBlob({ tier_gate_enforced: "true" })).toBe(false);
    expect(tierGateEnforcedFromBlob({ tier_gate_enforced: 1 })).toBe(false);
    expect(tierGateEnforcedFromBlob(null)).toBe(false);
  });

  it("tierProTenantsFromBlob keeps only strings", () => {
    expect(tierProTenantsFromBlob({ tier_pro_tenants: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
    expect(tierProTenantsFromBlob({ tier_pro_tenants: { a: 1 } })).toEqual([]);
  });

  it("tierConfigRejection validates each key", () => {
    expect(tierConfigRejection("tier_gate_enforced", true)).toBeNull();
    expect(tierConfigRejection("tier_gate_enforced", "true")).toMatch(/true or false/);
    expect(tierConfigRejection("tier_pro_tenants", ["73db45ff-457e-4541-bc8f-bdb625390204"])).toBeNull();
    expect(tierConfigRejection("tier_pro_tenants", ["nope"])).toMatch(/uuids/);
    expect(tierConfigRejection("tier_credits", { starter: 8000 })).toBeNull();
    expect(tierConfigRejection("tier_credits", { free: 1 })).toMatch(/starter, growth or pro/);
    expect(tierConfigRejection("tier_credits", { pro: "lots" })).toMatch(/whole number/);
    expect(tierConfigRejection("tier_agent_min", { seo: "starter" })).toBeNull();
    expect(tierConfigRejection("tier_agent_min", { seo: "gold" })).toMatch(/must be one of/);
    expect(tierConfigRejection("tier_agent_min", [])).toMatch(/must be an object/);
  });

  it("isPlanUpgradeError matches the SQL marker", () => {
    expect(isPlanUpgradeError({ message: PLAN_UPGRADE_REQUIRED })).toBe(true);
    expect(isPlanUpgradeError({ message: "insufficient_credits" })).toBe(false);
    expect(isPlanUpgradeError(null)).toBe(false);
  });
});

import { isEngineerBackendRun } from "../tiers";

describe("isEngineerBackendRun", () => {
  const server = (trigger: string, payload: unknown = {}) => ({ trigger, enqueuedByUser: false, payload });

  it("never exempts engineer work a founder approved from a cgo card", () => {
    expect(isEngineerBackendRun("engineer", server("a2a", { dispatched_by: "cgo" }))).toBe(false);
    expect(isEngineerBackendRun("engineer", server("a2a", { dispatched_by: "chief-of-staff" }))).toBe(true);
  });

  it("treats a handoff the founder addressed by name (@engineer) as their ask", () => {
    expect(isEngineerBackendRun("engineer", server("handoff", { founder_direct_agent_mention: true }))).toBe(false);
    expect(isEngineerBackendRun("engineer", server("a2a", { founder_direct_agent_mention: true }))).toBe(false);
    expect(isEngineerBackendRun("engineer", server("handoff", { founder_direct_agent_mention: "true" }))).toBe(true);
    expect(isEngineerBackendRun("engineer", server("handoff"))).toBe(true);
  });

  it("allows every server-started trigger", () => {
    for (const t of ["a2a", "webhook", "cron", "mcp", "handoff", "playbook", "channel_recipe", "qa-weekly-execute"]) {
      expect(isEngineerBackendRun("engineer", server(t))).toBe(true);
    }
  });
  it("blocks a founder chat ask on every chat surface", () => {
    for (const t of ["chat", "slack", "teams", "telegram", "discord", "whatsapp", "email", "manual"]) {
      expect(isEngineerBackendRun("engineer", server(t))).toBe(false);
    }
  });
  it("allows a server-built PR follow-up on a chat surface", () => {
    expect(isEngineerBackendRun("engineer", server("chat", { kind: "engineer_pr_followup" }))).toBe(true);
    expect(isEngineerBackendRun("engineer", server("slack", { kind: "engineer_pr_followup" }))).toBe(true);
  });
  it("never exempts a run a signed-in user enqueued, whatever it claims", () => {
    expect(isEngineerBackendRun("engineer", { trigger: "a2a", enqueuedByUser: true, payload: {} })).toBe(false);
    expect(
      isEngineerBackendRun("engineer", {
        trigger: "chat",
        enqueuedByUser: true,
        payload: { kind: "engineer_pr_followup" },
      }),
    ).toBe(false);
  });
  it("only ever exempts engineer", () => {
    expect(isEngineerBackendRun("fundraising", server("a2a"))).toBe(false);
    expect(isEngineerBackendRun("supply-demand-balancer", server("cron"))).toBe(false);
  });
  it("no run facts = a direct ask", () => {
    expect(isEngineerBackendRun("engineer", undefined)).toBe(false);
  });
});
