import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  numbers: {} as Record<string, number>,
  brand: "Upcar" as string | null,
  prompts: [] as Array<{ id: string; prompt_text: string; source: "zavi" | "custom" }>,
  rpc: { data: null as unknown, error: null as unknown },
  rpcArgs: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => state.enabled,
  getNumberSetting: async (k: string) => state.numbers[k] ?? 0,
  getStringSetting: async () => "",
}));
vi.mock("../context", () => ({
  loadBrandContext: async () => ({ brand: state.brand, owned_domains: ["upcar.ai"], rivals: ["Turo"] }),
  setHash: (v: string[]) => `h${v.length}`,
}));
vi.mock("../prompts", () => ({
  listPrompts: async () => ({ active: state.prompts, suggested: [] }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  preTenantRpc: vi.fn(),
  tenantRpc: async (_tid: string, _name: string, args: Record<string, unknown>) => {
    state.rpcArgs = args;
    return state.rpc;
  },
  tenantClient: () => ({
    from: () => ({
      update: (v: Record<string, unknown>) => {
        state.updates.push(v);
        const chain = { eq: () => chain };
        return chain;
      },
    }),
  }),
}));

import { openSweep, responseRowOf, slotGroupsOf } from "../sweep";

const TID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  process.env.DATAFORSEO_LOGIN = "l";
  process.env.DATAFORSEO_PASSWORD = "p";
  state.enabled = true;
  state.numbers = {
    geo_prompt_repeats: 3,
    geo_prompt_tenant_cap_7d: 600,
    geo_prompt_fleet_cap_usd_24h: 50,
    geo_prompt_max_sweeps_per_tenant: 3,
  };
  state.brand = "Upcar";
  state.prompts = [
    { id: "p1", prompt_text: "best car rental app", source: "zavi" },
    { id: "p2", prompt_text: "hourly car rental", source: "custom" },
  ];
  state.rpc = { data: { ok: true, sweep_id: "s1", planned: 24, used_7d: 0, cap_7d: 600 }, error: null };
  state.rpcArgs = null;
  state.updates = [];
});
afterEach(() => {
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
});

describe("openSweep — admission", () => {
  it("admits, passes the caps to the SQL guard, and fires the worker", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = await openSweep(TID, { country: "in", requestedBy: "u1" }, { send });
    expect(r).toMatchObject({ ok: true, sweep_id: "s1", country: "IN", planned: 24 });
    expect(state.rpcArgs).toMatchObject({
      p_country: "IN",
      p_location_code: 2356,
      p_engines: ["chatgpt", "claude", "gemini", "perplexity"],
      p_repeats: 3,
      p_tenant_cap_7d: 600,
      p_fleet_cap_usd_24h: 50,
      p_max_sweeps_per_tenant: 3,
    });
    expect(send).toHaveBeenCalledWith({ name: "geo.prompt_sweep.requested", data: { sweep_id: "s1", tenant_id: TID } });
  });

  it("never asks fewer than 3 repeats, whatever the setting says", async () => {
    state.numbers.geo_prompt_repeats = 1;
    await openSweep(TID, { requestedBy: "u1" }, { send: vi.fn() });
    expect(state.rpcArgs!.p_repeats).toBe(3);
  });

  it.each([
    ["disabled", () => (state.enabled = false)],
    ["not_configured", () => delete process.env.DATAFORSEO_LOGIN],
    ["brand_unknown", () => (state.brand = null)],
    ["no_prompts", () => (state.prompts = [])],
  ])("refuses %s before the spend guard is consulted", async (reason, arrange) => {
    arrange();
    const send = vi.fn();
    const r = await openSweep(TID, { requestedBy: "u1" }, { send });
    expect(r).toMatchObject({ ok: false, reason });
    expect(state.rpcArgs).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an untracked country", async () => {
    const r = await openSweep(TID, { country: "ZZ", requestedBy: "u1" }, { send: vi.fn() });
    expect(r).toMatchObject({ ok: false, reason: "unknown_country" });
  });

  it("passes the guard's refusal through, with the numbers for the cap", async () => {
    state.rpc = { data: { ok: false, reason: "tenant_cap_reached", used_7d: 500, cap_7d: 600 }, error: null };
    const r = await openSweep(TID, { requestedBy: "u1" }, { send: vi.fn() });
    expect(r).toMatchObject({ ok: false, reason: "tenant_cap_reached", used_7d: 500, cap_7d: 600 });
  });

  it("passes the lifetime per-tenant run cap through, and does not fire the worker", async () => {
    state.rpc = { data: { ok: false, reason: "tenant_limit_reached", runs_used: 3, runs_limit: 3 }, error: null };
    const send = vi.fn();
    const r = await openSweep(TID, { requestedBy: "u1" }, { send });
    expect(r).toMatchObject({ ok: false, reason: "tenant_limit_reached" });
    expect((r as { message: string }).message).toContain("used all its GEO runs");
    expect(send).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the guard itself errors", async () => {
    state.rpc = { data: null, error: { message: "boom" } };
    const send = vi.fn();
    const r = await openSweep(TID, { requestedBy: "u1" }, { send });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("runs an admitted sweep in-process when the worker event cannot be sent — never cancels it", async () => {
    const runInProcess = vi.fn();
    const r = await openSweep(
      TID,
      { requestedBy: "u1" },
      { send: vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8288")), runInProcess },
    );
    expect(r).toMatchObject({ ok: true, sweep_id: "s1", runner: "in_process" });
    expect(runInProcess).toHaveBeenCalledWith(TID, "s1");
    expect(state.updates).toEqual([]);
  });

  it("does NOT run in-process when the send failure could still have been delivered", async () => {
    const runInProcess = vi.fn();
    const r = await openSweep(
      TID,
      { requestedBy: "u1" },
      { send: vi.fn().mockRejectedValue(new Error("request timed out after 5000ms")), runInProcess },
    );
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(runInProcess).not.toHaveBeenCalled();
  });

  it("leaves the sweep to the worker alone when the event IS sent", async () => {
    const runInProcess = vi.fn();
    const r = await openSweep(TID, { requestedBy: "u1" }, { send: vi.fn().mockResolvedValue(undefined), runInProcess });
    expect(r).toMatchObject({ ok: true, runner: "worker" });
    expect(runInProcess).not.toHaveBeenCalled();
  });
});

describe("responseRowOf", () => {
  const sweep = { id: "s1", brand: "Upcar", owned_domains: ["upcar.ai"], rivals: ["Turo", "Getaround"] };
  const slot = { prompt_id: "p1", engine: "chatgpt" as const, repeat_index: 2 };

  it("stores a failed slot as an error row, with no answer fields", () => {
    const row = responseRowOf(sweep, slot, { ok: false, error_code: "dataforseo_timeout", cost_usd: null, data_source: "dataforseo.llm_scraper" });
    expect(row).toMatchObject({ status: "error", error_code: "dataforseo_timeout", repeat_index: 2 });
    expect(row).not.toHaveProperty("answer_text");
  });

  it("reads mention, citation, rivals and position off the answer", () => {
    const row = responseRowOf(sweep, slot, {
      ok: true,
      text: "Upcar is a good pick for hourly rentals.\n\n- Turo\n- Zoomcar",
      citations: [
        { url: "https://www.upcar.ai/pricing/?utm_source=chatgpt.com", title: "Pricing", domain: null },
        { url: "https://vertexaisearch.cloud.google.com/r/1", title: "reddit.com", domain: null },
      ],
      fan_out_queries: ["hourly car rental"],
      model: "gpt-4o",
      cost_usd: 0.004,
      data_source: "dataforseo.llm_scraper",
    });
    expect(row).toMatchObject({
      status: "ok",
      brand_mentioned: true,
      owned_cited: true,
      rivals_mentioned: ["Turo"],
      answer_position: "primary",
      fan_out_queries: ["hourly car rental"],
    });
    expect(row.citations).toEqual([
      { url: "https://upcar.ai/pricing", domain: "upcar.ai", title: "Pricing", infra: false },
      { url: "https://vertexaisearch.cloud.google.com/r/1", domain: "reddit.com", title: "reddit.com", infra: false },
    ]);
  });
});

describe("slotGroupsOf", () => {
  it("orders groups prompt by prompt across every engine", () => {
    const groups = slotGroupsOf({
      prompts: [
        { id: "p1", text: "a", source: "zavi" },
        { id: "p2", text: "b", source: "zavi" },
      ],
      engines: ["chatgpt", "claude"],
    });
    expect(groups).toEqual([
      { prompt_id: "p1", engine: "chatgpt" },
      { prompt_id: "p1", engine: "claude" },
      { prompt_id: "p2", engine: "chatgpt" },
      { prompt_id: "p2", engine: "claude" },
    ]);
  });
});
