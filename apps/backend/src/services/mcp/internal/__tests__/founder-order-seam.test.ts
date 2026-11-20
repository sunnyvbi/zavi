
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import "@/services/agents/engine/openai-sandbox-tools";

const resolvers = vi.hoisted(() => ({
  google: vi.fn(async (ctx: { emit_decision?: unknown }) => ctx.emit_decision),
  meta: vi.fn(async (ctx: { emit_decision?: unknown }) => ctx.emit_decision),
}));
vi.mock("@/services/tools/google-ads/write/_exec-action", async (orig) => ({
  ...(await orig<object>()),
  resolveGoogleAdsEmit: (ctx: { emit_decision?: unknown }) => resolvers.google(ctx),
}));
vi.mock("@/services/tools/meta-ads/write/_exec-action", async (orig) => ({
  ...(await orig<object>()),
  resolveMetaAdsEmit: (ctx: { emit_decision?: unknown }) => resolvers.meta(ctx),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

vi.mock("@/services/tools/google-ads/write/_video-guard", () => ({ assertNotVideoCampaign: async () => {}, assertNotVideoAdGroup: async () => {} }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => true }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", () => ({ assertUsdGoogleAccount: async () => {} }));
vi.mock("@/services/tools/google-ads/write/cap-reader", () => ({
  readTenantGoogleCapAndToday: async () => ({
    cap: { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: null, max_daily_total_change_usd: null },
    today_total_change_usd: 0,
  }),
}));
vi.mock("@/services/growth/cgo-ads", async (orig) => ({ ...(await orig<object>()), cgoAdBudget: async () => ({ id: "b1" }), cgoRunsAdsUnderBudget: async () => true }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));
vi.mock("@/services/tools/meta-ads/write/_user-initiated-flag-check", () => ({ isUserInitiatedSpendApplyEnabled: async () => true }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => {
  const read = async () => ({
    cap: { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: 0.9, max_daily_total_change_usd: 1000 },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  });
  return { readTenantCapAndToday: read, readTenantCapRowAndToday: read };
});

import { GOOGLE_ADS_TOOLS, callGoogleAdsTool } from "../google-ads";
import { META_ADS_TOOLS, callMetaAdsTool } from "../meta-ads";
import { rulesSteerRun } from "@/services/rules/load";

const T = "tenant-A";

function recorder() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const emit = vi.fn(async (cls: string, body: unknown) => {
    calls.push([cls, body as Record<string, unknown>]);
    return "11111111-1111-4111-8111-111111111111";
  });
  return { emit, calls };
}

type ToolLike = { name?: unknown; execute?: unknown };
async function loadModules(dir: string, match: RegExp): Promise<Record<string, Record<string, unknown>>> {
  const abs = join(__dirname, dir);
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of readdirSync(abs).filter((n) => match.test(n))) out[f] = (await import(join(abs, f))) as Record<string, unknown>;
  return out;
}
const proposeExports = (mods: Record<string, Record<string, unknown>>, prefix: string): ToolLike[] =>
  Object.values(mods)
    .flatMap((m) => Object.values(m))
    .filter((v): v is ToolLike => !!v && typeof v === "object" && typeof (v as ToolLike).execute === "function" && String((v as ToolLike).name ?? "").startsWith(prefix));

describe("every propose tool goes through the seam (by import)", () => {
  it("each exported Google propose tool is served by the google_ads server", async () => {
    const mods = await loadModules("../../../tools/google-ads/write", /^propose_.*\.ts$/);
    const tools = proposeExports(mods, "google_ads_propose_");
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) expect(GOOGLE_ADS_TOOLS as readonly unknown[], String(t.name)).toContain(t);
  });

  it("each exported Meta propose tool is served by the meta_ads server", async () => {
    const mods = await loadModules("../../../tools/meta-ads/write", /^propose.*\.ts$/);
    const tools = proposeExports(mods, "meta_ads_propose_");
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) expect(META_ADS_TOOLS as readonly unknown[], String(t.name)).toContain(t);
  });
});

describe("real tool executions through the seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ACCEPTANCE A1 (thread 02be38b0), Google: 'okay lets do those changes' under Founder Rules files the cut as the review twin for the founder", async () => {
    const r = recorder();
    const rules_steered = rulesSteerRun({ ruleCount: 2, currentHumanText: "okay lets do those changes" });
    expect(rules_steered?.budget).toBe(true);
    const res = await callGoogleAdsTool(
      { tenant_id: T, run_id: "run-1", run_trigger: "chat", founder_chat_order: true, rules_steered, emit_decision: r.emit },
      "propose_budget_change",
      { campaign_id: "111", current_daily_budget_usd: 20, proposed_daily_budget_usd: 10, rationale: "cut a campaign that booked nothing", name: "Search - hosts" },
    );
    expect(res.is_error).toBe(false);
    expect(r.calls).toHaveLength(1);
    const [cls, body] = r.calls[0];
    expect(cls).toBe("google_ads.update_campaign_budget_review");
    expect(body).toMatchObject({ origin: "user_initiated_chat", founder_chat_order: true, daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });
    expect(body).not.toHaveProperty("authorized_effective_cap");
  });

  it("the same Google turn without the marker carries no founder origin", async () => {
    const r = recorder();
    const rules_steered = rulesSteerRun({ ruleCount: 2, currentHumanText: "okay lets do those changes" });
    await callGoogleAdsTool(
      { tenant_id: T, run_id: "run-1", run_trigger: "chat", rules_steered, emit_decision: r.emit },
      "propose_budget_change",
      { campaign_id: "111", current_daily_budget_usd: 20, proposed_daily_budget_usd: 10, rationale: "cut" },
    );
    expect(r.calls[0][1].origin).toBeUndefined();
  });

  it("Meta: a founder's within-cap budget raise on the fast path is the review twin with no authorized cap", async () => {
    const r = recorder();
    const res = await callMetaAdsTool(
      { tenant_id: T, run_id: "run-1", run_trigger: "chat", founder_chat_order: true, emit_decision: r.emit },
      "propose_budget_change",
      { ad_set_id: "as-1", current_daily_budget_usd: 50, proposed_daily_budget_usd: 55, rationale: "founder asked", match_confidence: "exact" },
    );
    expect(res.is_error).toBe(false);
    const [cls, body] = r.calls[0];
    expect(cls).toBe("meta_ads.update_ad_set_budget_review");
    expect(body).toMatchObject({ origin: "user_initiated_chat", founder_chat_order: true, daily_budget_usd: 55 });
    expect(body).not.toHaveProperty("authorized_effective_cap");
  });

  it("Meta on the channel_actions rail: the class is kept, the founder origin still stamped", async () => {
    const tile = recorder();
    resolvers.meta.mockImplementationOnce(async () => tile.emit);
    const legacy = recorder();
    await callMetaAdsTool(
      { tenant_id: T, run_id: "run-1", run_trigger: "chat", founder_chat_order: true, emit_decision: legacy.emit },
      "propose_status_change",
      { object_id: "as-1", level: "adset", status: "ACTIVE", rationale: "turn it back on" },
    );
    expect(legacy.calls).toEqual([]);
    expect(tile.calls[0][0]).toMatch(/^meta_ads\.set_status/);
    expect(tile.calls[0][1]).toMatchObject({ origin: "user_initiated_chat", founder_chat_order: true });
  });

  it("the Google tool context gets the server-set trigger and the marker", async () => {
    const r = recorder();
    await callGoogleAdsTool(
      { tenant_id: T, run_id: "run-1", run_trigger: "chat", founder_chat_order: true, emit_decision: r.emit },
      "propose_status_change",
      { campaign_id: "111", status: "PAUSED", rationale: "pause it" },
    );
    expect(r.calls[0][0]).toBe("google_ads.set_status_review");
    expect(r.calls[0][1]).toMatchObject({ origin: "user_initiated_chat", status: "PAUSED" });
  });
});
