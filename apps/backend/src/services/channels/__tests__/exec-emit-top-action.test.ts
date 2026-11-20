
import { describe, it, expect, vi, beforeEach } from "vitest";

const switchedChannelForRun = vi.fn();
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: (...a: unknown[]) => switchedChannelForRun(...a),
}));
const filedCount = vi.fn(async () => ({ count: 0, error: null as unknown }));
const countQuery = { select: () => countQuery, eq: () => countQuery, not: () => filedCount() };
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantClient: () => ({ from: () => countQuery }) }));

import { resolveChannelExecEmit } from "@/services/channels/exec-emit";

const emit_decision = vi.fn(async () => "d-1");
const write = vi.fn(async () => "action-1");
const scope = vi.fn();
const META = new Set(["meta_ads"]);
const topAction = { key: "create_new_ad", by: "u1", instruction: "x", inputs: { about: "a", link: "https://x.example", goal: "visit", placement: "both", daily_budget: 10 } };

beforeEach(() => {
  vi.clearAllMocks();
  switchedChannelForRun.mockResolvedValue("meta_ads");
  scope.mockResolvedValue({ channel_slug: "meta_ads", top_action: topAction });
});

describe("resolveChannelExecEmit: top-action runs", () => {
  it("writes an allowed class", async () => {
    const emit = await resolveChannelExecEmit(META, { tenant_id: "t", run_id: "r", emit_decision, top_action_run: true }, write, scope);
    await expect(emit!("meta_ads.create_ad", {})).resolves.toBe("action-1");
  });

  it("refuses any other class with nothing written", async () => {
    const emit = await resolveChannelExecEmit(META, { tenant_id: "t", run_id: "r", emit_decision, top_action_run: true }, write, scope);
    await expect(emit!("meta_ads.update_ad_set_budget", {})).rejects.toMatchObject({ code: "top_action_scope" });
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed when the run's request cannot be read", async () => {
    scope.mockRejectedValue(new Error("db down"));
    const emit = await resolveChannelExecEmit(META, { tenant_id: "t", run_id: "r", emit_decision, top_action_run: true }, write, scope);
    await expect(emit!("meta_ads.create_ad", {})).rejects.toMatchObject({ code: "channel_stamp_unreadable" });
    expect(write).not.toHaveBeenCalled();
  });

  it("a normal run is unchanged and reads nothing extra", async () => {
    const emit = await resolveChannelExecEmit(META, { tenant_id: "t", run_id: "r", emit_decision }, write, scope);
    await expect(emit!("meta_ads.update_ad_set_budget", {})).resolves.toBe("action-1");
    expect(scope).not.toHaveBeenCalled();
  });
});

describe("resolveChannelExecEmit: a capped action (SEO Fix a page)", () => {
  const SEO = new Set(["seo"]);
  const fixPage = { key: "fix_page", by: "u1", instruction: "x", inputs: { page_url: "https://shop.example/pricing" } };
  const ctx = { tenant_id: "t", run_id: "r", emit_decision, top_action_run: true };

  beforeEach(() => {
    switchedChannelForRun.mockResolvedValue("seo");
    scope.mockResolvedValue({ channel_slug: "seo", top_action: fixPage });
    filedCount.mockResolvedValue({ count: 0, error: null });
  });

  it("files one card for the named page", async () => {
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    await expect(emit!("seo.create_pr.v1", { page_url: "https://www.shop.example/pricing/" })).resolves.toBe("action-1");
  });

  it("refuses a card for another page, with nothing written", async () => {
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    await expect(emit!("seo.create_pr.v1", { page_url: "https://shop.example/about" })).rejects.toMatchObject({ code: "top_action_mismatch" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a second card in the same run, even when the first was kept from an earlier run", async () => {
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    await emit!("seo.create_pr.v1", { page_url: "https://shop.example/pricing" });
    await expect(emit!("seo.create_pr.v1", { page_url: "https://shop.example/pricing" })).rejects.toMatchObject({ code: "top_action_cap" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("two parallel tool calls (each with its own emitter) file one card", async () => {
    const a = await resolveChannelExecEmit(SEO, ctx, write, scope);
    const b = await resolveChannelExecEmit(SEO, ctx, write, scope);
    const body = { page_url: "https://shop.example/pricing" };
    const out = await Promise.allSettled([a!("seo.create_pr.v1", body), b!("seo.create_pr.v1", body)]);
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a failed write frees the slot for a retry", async () => {
    write.mockRejectedValueOnce(new Error("db down"));
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    const body = { page_url: "https://shop.example/pricing" };
    await expect(emit!("seo.create_pr.v1", body)).rejects.toThrow("db down");
    await expect(emit!("seo.create_pr.v1", body)).resolves.toBe("action-1");
  });

  it("refuses when a retry of the run already filed the card", async () => {
    filedCount.mockResolvedValue({ count: 1, error: null });
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    await expect(emit!("seo.create_pr.v1", { page_url: "https://shop.example/pricing" })).rejects.toMatchObject({ code: "top_action_cap" });
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed when the count cannot be read", async () => {
    filedCount.mockResolvedValue({ count: null as unknown as number, error: { message: "db down" } });
    const emit = await resolveChannelExecEmit(SEO, ctx, write, scope);
    await expect(emit!("seo.create_pr.v1", { page_url: "https://shop.example/pricing" })).rejects.toMatchObject({ code: "top_action_cap" });
    expect(write).not.toHaveBeenCalled();
  });
});
