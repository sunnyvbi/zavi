import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateOf, VISIBILITY_DISCLOSURE, type VisibilityMetrics } from "../geo/visibility/metrics";
import type { VisibilityPanel } from "../geo/visibility/read";

const getVisibility = vi.fn();
vi.mock("../geo/visibility/read", async (orig) => ({
  ...(await orig<typeof import("../geo/visibility/read")>()),
  getVisibility: (...a: unknown[]) => getVisibility(...a),
}));

const ensureStarterPrompts = vi.fn();
const listPrompts = vi.fn();
vi.mock("../geo/visibility/prompts", async (orig) => ({
  ...(await orig<typeof import("../geo/visibility/prompts")>()),
  ensureStarterPrompts: (...a: unknown[]) => ensureStarterPrompts(...a),
  listPrompts: (...a: unknown[]) => listPrompts(...a),
}));
const planLock = vi.fn();
vi.mock("@/services/growth/preview-plan", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/preview-plan")>()),
  refuseIfChannelPlanLocked: (...a: unknown[]) => planLock(...a),
}));

import { callGrowthTool, listGrowthTools } from "@/services/mcp/internal/growth";

const CTX_TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

function cell(collected: number, mentioned: number) {
  return { collected, mentioned, cited: 0, mention_rate: collected ? mentioned / collected : null };
}

function metrics(): VisibilityMetrics {
  const mention = rateOf(30, 100);
  const citation = rateOf(10, 100);
  const engines = { chatgpt: cell(25, 8), claude: cell(25, 7), gemini: cell(25, 8), perplexity: cell(25, 7) };
  const row = (id: string, rivalOnly: number) => ({
    prompt_id: id,
    prompt_text: `prompt ${id}`,
    source: "zavi" as const,
    engines,
    all: cell(12, 2),
    rival_only_responses: rivalOnly,
    top_rivals: [{ name: "Rival A", responses: rivalOnly }],
    cited_domains: [{ domain: "directory.example", responses: rivalOnly, kind: "other" as const, rival: null }],
  });
  return {
    tier: 2,
    provenance: "sampled",
    disclosure: VISIBILITY_DISCLOSURE,
    responses: { planned: 120, collected: 100, failed: 20, sweeps: 2, prompts: 10, engines: 4, repeats: 3 },
    prompt_set_changed: false,
    mention_rate: { ...mention, by_engine: [{ ...rateOf(8, 25), engine: "chatgpt", label: "ChatGPT" }] },
    citation_rate: {
      ...citation,
      by_engine: [{ ...rateOf(3, 25), engine: "chatgpt", label: "ChatGPT" }],
      cited_pages: [{ url: "https://example.com/a", responses: 4 }],
      cited_pages_total: 1,
    },
    source_mix: {
      domains: Array.from({ length: 14 }, (_, i) => ({
        domain: `d${i}.com`,
        responses: 14 - i,
        used: 0.1,
        citations: 14 - i,
        avg_citations: 1,
        kind: "other" as const,
        rival: null,
      })),
      domains_total: 14,
      infra_hidden: [],
    },
    share_of_voice: {
      state: "ok",
      share: 0.4,
      brand_mentions: 30,
      rival_mentions: 45,
      rivals: [{ name: "Rival A", mentions: 45, share: 0.6 }],
      rival_set_hash: "h",
      responses_excluded_for_rival_change: 0,
    },
    answer_position: {} as VisibilityMetrics["answer_position"],
    prompt_coverage: [],
    prompt_grid: {
      rows: [row("p1", 0), row("p2", 5), row("p3", 9)],
      totals: { engines, all: cell(100, 30) },
    },
  };
}

function panel(over: Partial<VisibilityPanel> = {}): VisibilityPanel {
  return {
    state: "ok",
    country: "US",
    engine: null,
    window_days: 90,
    window: { from: "2026-07-12T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" },
    metrics: metrics(),
    deltas: {
      mention_rate: { delta_pp: 4.2, significant: false },
      citation_rate: { unavailable: "prompt_set_changed" },
      share_of_voice: { unavailable: "no_previous_window" },
    },
    running: null,
    history: [],
    config: {
      enabled: true,
      configured: true,
      brand: "Example",
      owned_domains: ["example.com"],
      rivals: ["Rival A"],
      rival_set_hash: "h",
      prompts_active: 10,
      suggestions_pending: 0,
      starter_stale: false,
      engines: [],
      repeats: 3,
      countries: [],
      run_limit_reached: false,
      runs_used: 2,
      run_limit: 12,
    },
    ...over,
  };
}

beforeEach(() => {
  getVisibility.mockReset();
  ensureStarterPrompts.mockReset();
  listPrompts.mockReset().mockResolvedValue({ active: [], suggested: [] });
  planLock.mockReset().mockResolvedValue(null);
});

const prompt = (prompt_text: string) => ({ id: prompt_text, prompt_text, source: "zavi", status: "active", rationale: null, created_at: "", status_changed_at: "" });
const noQuestions = (over: Partial<VisibilityPanel["config"]> = {}) =>
  panel({ state: "no_prompts", metrics: null, config: { ...panel().config, prompts_active: 0, ...over } });

describe("growth geo_visibility tool", () => {
  it("is advertised on the growth facade as a read", () => {
    const t = listGrowthTools().find((x) => x.tool_name === "geo_visibility");
    expect(t?.effect).toBe("read");
  });

  it("reads the run's tenant, never one named in the input, with a 90-day default", async () => {
    getVisibility.mockResolvedValue(panel());
    const res = await callGrowthTool(CTX_TENANT, "geo_visibility", { tenant_id: OTHER_TENANT });
    expect(res.ok).toBe(true);
    expect(getVisibility).toHaveBeenCalledTimes(1);
    expect(getVisibility).toHaveBeenCalledWith(CTX_TENANT, { days: 90, country: null, engine: null });
  });

  it("returns the slim sampled shape: n and interval on every rate, disclosure, top lists capped", async () => {
    getVisibility.mockResolvedValue(panel());
    const res = await callGrowthTool(CTX_TENANT, "geo_visibility", { days: 30, country: "US" });
    expect(getVisibility).toHaveBeenCalledWith(CTX_TENANT, { days: 30, country: "US", engine: null });
    const out = JSON.parse(res.content);
    expect(out.state).toBe("ok");
    expect(out.disclosure).toBe(VISIBILITY_DISCLOSURE);
    expect(out.mention_rate).toMatchObject({ rate: 0.3, numerator: 30, n: 100 });
    expect(out.mention_rate.ci95.low).toBeLessThan(0.3);
    expect(out.mention_rate.ci95.high).toBeGreaterThan(0.3);
    expect(out.mention_rate.by_engine[0]).toMatchObject({ engine: "ChatGPT", numerator: 8, n: 25 });
    expect(out.citation_rate).toMatchObject({ numerator: 10, n: 100 });
    expect(out.share_of_voice).toMatchObject({ state: "ok", share: 0.4, brand_mentions: 30, rival_mentions: 45 });
    expect(out.deltas.citation_rate).toEqual({ unavailable: "prompt_set_changed" });
    expect(out.top_source_domains).toHaveLength(10);
    expect(out.rival_only_prompts.map((p: { prompt: string }) => p.prompt)).toEqual(["prompt p3", "prompt p2"]);
    expect(out.rival_only_prompts[0].rivals_named_on_prompt).toEqual(["Rival A"]);
    expect(out.rival_only_prompts[0].cited_domains_on_prompt).toEqual([{ domain: "directory.example", kind: "other", responses: 9 }]);
    expect(out.runs).toEqual({ used: 2, limit: 12, limit_reached: false });
    expect(out.history).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThan(6000);
  });

  it("says unmeasured plainly when there is no sweep in the window", async () => {
    getVisibility.mockResolvedValue(panel({ state: "never_run", metrics: null }));
    const out = JSON.parse((await callGrowthTool(CTX_TENANT, "geo_visibility", {})).content);
    expect(out.state).toBe("never_run");
    expect(out.mention_rate).toBeNull();
    expect(out.citation_rate).toBeNull();
    expect(out.top_source_domains).toEqual([]);
    expect(out.disclosure).toBe(VISIBILITY_DISCLOSURE);
  });

  it("with no tracked questions, creates the starter set and reads again, so Check AI answers can run", async () => {
    getVisibility.mockResolvedValueOnce(noQuestions()).mockResolvedValueOnce(panel({ state: "never_run", metrics: null, config: { ...panel().config, prompts_active: 7 } }));
    ensureStarterPrompts.mockResolvedValue({ ok: true, state: "started", active: [], accepted: 7 });
    listPrompts.mockResolvedValue({ active: ["a", "b", "c", "d", "e", "f", "g"].map((x) => prompt(`question ${x}`)), suggested: [] });
    const out = JSON.parse((await callGrowthTool(CTX_TENANT, "geo_visibility", {})).content);
    expect(ensureStarterPrompts).toHaveBeenCalledWith(CTX_TENANT);
    expect(planLock).toHaveBeenCalledWith(CTX_TENANT, "geo");
    expect(getVisibility).toHaveBeenCalledTimes(2);
    expect(out.state).toBe("never_run");
    expect(out.tracked_questions).toEqual({
      active: 7,
      waiting_for_review: 0,
      created_this_run: true,
      sample: ["question a", "question b", "question c", "question d", "question e"],
    });
  });

  it("creates nothing on a run whose writes are suppressed (preview, best-of-N, variants lab)", async () => {
    getVisibility.mockResolvedValue(noQuestions());
    const res = await callGrowthTool(CTX_TENANT, "geo_visibility", {}, undefined, { writes_suppressed: true });
    expect(ensureStarterPrompts).not.toHaveBeenCalled();
    expect(JSON.parse(res.content).tracked_questions).toMatchObject({ active: 0, created_this_run: false, sample: [] });
  });

  it("creates nothing when the plan does not include GEO, the same gate as the page", async () => {
    getVisibility.mockResolvedValue(noQuestions());
    planLock.mockResolvedValue({ message: "locked", body: {} });
    await callGrowthTool(CTX_TENANT, "geo_visibility", {});
    expect(ensureStarterPrompts).not.toHaveBeenCalled();
    expect(getVisibility).toHaveBeenCalledTimes(1);
  });

  it("drafts held for review stay a person's to accept: no second read, the count is reported", async () => {
    getVisibility.mockResolvedValue(noQuestions({ suggestions_pending: 5 }));
    ensureStarterPrompts.mockResolvedValue({ ok: true, state: "needs_review", active: [], accepted: 0 });
    const out = JSON.parse((await callGrowthTool(CTX_TENANT, "geo_visibility", {})).content);
    expect(getVisibility).toHaveBeenCalledTimes(1);
    expect(out.state).toBe("no_prompts");
    expect(out.tracked_questions).toMatchObject({ active: 0, waiting_for_review: 5, created_this_run: false });
  });

  it("a failed starter call leaves the read as it was", async () => {
    getVisibility.mockResolvedValue(noQuestions());
    ensureStarterPrompts.mockRejectedValue(new Error("model down"));
    const res = await callGrowthTool(CTX_TENANT, "geo_visibility", {});
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content).state).toBe("no_prompts");
  });

  it("leaves a company that already has questions alone", async () => {
    getVisibility.mockResolvedValue(panel());
    await callGrowthTool(CTX_TENANT, "geo_visibility", {});
    expect(ensureStarterPrompts).not.toHaveBeenCalled();
  });

  it("refuses a window the dashboard does not compute", async () => {
    const res = await callGrowthTool(CTX_TENANT, "geo_visibility", { days: 14 });
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content).error).toBe("geo_visibility_bad_window");
    expect(getVisibility).not.toHaveBeenCalled();
  });
});
