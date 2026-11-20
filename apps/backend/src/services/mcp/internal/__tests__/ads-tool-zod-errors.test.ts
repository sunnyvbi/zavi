
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
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

import { callGoogleAdsTool } from "../google-ads";
import { callMetaAdsTool } from "../meta-ads";
import { zodToolErrorResult } from "../_zod-tool-error";

const T = "tenant-A";
const ID = "11111111-1111-4111-8111-111111111111";

function recorder(impl?: () => Promise<string>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const emit = vi.fn(async (cls: string, body: unknown) => {
    calls.push([cls, body as Record<string, unknown>]);
    return impl ? impl() : ID;
  });
  return { emit, calls };
}
const ctxWith = (emit: unknown) => ({ tenant_id: T, run_id: "run-1", run_trigger: "cron", emit_decision: emit }) as Parameters<typeof callGoogleAdsTool>[0];

describe("ads MCP wrappers: Zod failures are tool error results", () => {
  it("Google: a bad argument returns invalid_input with the failing field, and files nothing", async () => {
    const r = recorder();
    const res = await callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", {
      level: "campaign",
      campaign_id: "7",
      negative: true,
      keywords: [{ text: "competitor brand", match_type: "BROADISH" }],
      rationale: "block competitor terms",
    });
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    const out = JSON.parse(res.content) as { error: string; message: string; issues: Array<{ path: string; code: string; message: string }> };
    expect(out.error).toBe("invalid_input");
    expect(out.issues.map((i) => i.path)).toContain("keywords.0.match_type");
    expect(out.message).toContain("Nothing was filed");
    expect(res.content).not.toContain("BROADISH");
    expect(r.calls).toEqual([]);
  });

  it("Meta: a missing field returns invalid_input, not a throw", async () => {
    const r = recorder();
    const res = await callMetaAdsTool(ctxWith(r.emit) as Parameters<typeof callMetaAdsTool>[0], "propose_budget_change", { ad_set_id: "as-1", rationale: "x" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("invalid_input");
    expect(r.calls).toEqual([]);
  });

  it("the issue list is bounded", async () => {
    const r = recorder();
    const keywords = Array.from({ length: 30 }, () => ({ text: 5, match_type: "NOPE" }));
    const res = await callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", { level: "campaign", campaign_id: "7", negative: true, keywords, rationale: "r" });
    const out = JSON.parse(res.content) as { issues: unknown[]; more_issues?: number };
    expect(out.issues.length).toBeLessThanOrEqual(10);
    expect(out.more_issues).toBeGreaterThan(0);
  });

  it("a ZodError raised later inside the tool still throws (a bug, not the model's to fix)", async () => {
    const r = recorder(async () => {
      throw new ZodError([{ code: "custom", path: ["body", "x"], message: "bad body", input: undefined }] as never);
    });
    await expect(
      callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", { level: "campaign", campaign_id: "7", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "r" }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("a path segment that is not a plain identifier (a caller-supplied key) is masked", () => {
    const e = new ZodError([
      { code: "custom", path: ["flexible_spec", "my secret key!", 0], message: "bad", input: undefined },
    ] as never);
    const res = zodToolErrorResult({ tenant_id: T, run_id: null }, "meta_ads", "propose_edit", e, 1);
    const out = JSON.parse(res.content) as { issues: Array<{ path: string }> };
    expect(out.issues[0].path).toBe("flexible_spec.*.0");
    expect(res.content).not.toContain("secret");
  });

  it("any other error still throws", async () => {
    const r = recorder(async () => {
      throw new Error("db down");
    });
    await expect(
      callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", { level: "campaign", campaign_id: "7", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "r" }),
    ).rejects.toThrow("db down");
  });
});

describe("propose_keywords: over-long rationale and the auto-apply claim", () => {
  it("a rationale over 500 chars is trimmed at a word and the keywords are filed", async () => {
    const r = recorder();
    const long = "These seven competitor searches cost money and book nothing for this campaign. ".repeat(10);
    const res = await callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", {
      level: "campaign",
      campaign_id: "7",
      negative: true,
      keywords: [{ text: "competitor brand", match_type: "PHRASE" }],
      rationale: long,
    });
    expect(res.is_error).toBe(false);
    expect(r.calls).toHaveLength(1);
    const rationale = r.calls[0][1].rationale as string;
    expect(rationale.length).toBeLessThanOrEqual(500);
    expect(rationale.endsWith("…")).toBe(true);
    expect(long.startsWith(rationale.slice(0, -1).trimEnd())).toBe(true);
  });

  it("a rationale within the limit is stored exactly as written", async () => {
    const r = recorder();
    const text = "Block  two\nterms that\tbook nothing.";
    await callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", { level: "campaign", campaign_id: "7", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: text });
    expect(r.calls[0][1].rationale).toBe(text);
  });

  it("makes no fixed will_auto_apply claim (Autopilot may approve add_keywords on filing)", async () => {
    const r = recorder();
    const res = await callGoogleAdsTool(ctxWith(r.emit), "propose_keywords", { level: "campaign", campaign_id: "7", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "r" });
    const out = JSON.parse(res.content) as Record<string, unknown>;
    expect(out.decision_id).toBe(ID);
    expect("will_auto_apply" in out).toBe(false);
  });
});
