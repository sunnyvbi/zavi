
import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ value: [] as Array<{ stage: string; meta: unknown }> }));
const deliver = vi.hoisted(() => vi.fn(async () => ({ images: [], generated: 0 })));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => {
        const q = {
          eq: () => q,
          limit: async () => ({ data: rows.value, error: null }),
        };
        return q;
      },
    }),
  }),
}));
vi.mock("@/services/reports/deliver-social-image", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deliverSocialImage: deliver,
}));

const ev = (tool_name: string) => ({ stage: "tool_use_completed", meta: { tool_name } });
const started = (tool_name: string) => ({ stage: "tool_use_started", meta: { tool_name } });
const errored = (tool_name: string) => ({ stage: "tool_use_errored", meta: { tool_name } });
const SELF = "mcp__server__report__render_social_image";
const ctx = { tenant_id: "t", run_id: "r" } as never;
const input = { posts: [{ headline: "hi" }] } as never;

async function run() {
  const { renderSocialImageTool } = await import("../render_social_image");
  return renderSocialImageTool.execute(ctx, input);
}

describe("read-before-creative gate", () => {
  beforeEach(() => { vi.resetModules(); deliver.mockClear(); });

  it("refuses a run that has looked at nothing — ignoring THIS call's own started row", async () => {
    rows.value = [
      ev("assistant_turn"),
      ev("ToolSearch"),
      started("mcp__server__report__render_social_image"),
    ];
    await expect(run()).rejects.toMatchObject({ code: "creative_ungrounded" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("allows it once a real read happened", async () => {
    rows.value = [ev("mcp__server__apify__scrape_meta_ads"), ev("ToolSearch")];
    await run();
    expect(deliver).toHaveBeenCalled();
  });

  it("refuses ONCE — the retry goes through, so nobody is locked out", async () => {
    rows.value = [ev("ToolSearch"), started(SELF), started(SELF)];
    await run();
    expect(deliver).toHaveBeenCalled();
  });

  it("a tenant with NO connector is never locked out — a failed read still counts as looking", async () => {
    rows.value = [
      ev("ToolSearch"),
      started(SELF),
      errored("mcp__server__meta_ads__list_campaigns"),
      started(SELF),
    ];
    await run();
    expect(deliver).toHaveBeenCalled();
  });

  it("an attempted read that never finished still counts", async () => {
    rows.value = [started("mcp__server__web_search__search"), started(SELF)];
    await run();
    expect(deliver).toHaveBeenCalled();
  });

  it("fails OPEN when the ledger read errors", async () => {
    rows.value = null as never;
    await run();
    expect(deliver).toHaveBeenCalled();
  });
});
