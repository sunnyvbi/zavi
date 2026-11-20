
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ exec: vi.fn(), resolve: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: m.exec }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.resolve }));

import { pinterestInsightsReadTool } from "../read";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, log: vi.fn() } as never;
const OWNED = { tenant_id: TENANT, toolkit: "pinterest", connected_account_id: "ca_pin" };
const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });

beforeEach(() => {
  m.exec.mockReset();
  m.resolve.mockReset().mockResolvedValue(OWNED);
});

function route(bySlug: Record<string, unknown>) {
  m.exec.mockImplementation(async (a: { tool_slug: string }) => bySlug[a.tool_slug]);
}

describe("pinterest_insights_read (composio)", () => {
  it("reads profile, boards, account totals and top pins for the tenant's own account", async () => {
    route({
      PINTEREST_GET_PROFILE: ok({ username: "acme", account_type: "BUSINESS", follower_count: 120, pin_count: 40, board_count: 2, website_url: "https://acme.com" }),
      PINTEREST_LIST_BOARDS: ok({ items: [{ id: "971159175836868903", name: "Linen bedding", description: "Bedroom ideas", privacy: "PUBLIC", pin_count: 12 }], next_cursor: null }),
      PINTEREST_GET_ACCOUNT_ANALYTICS: ok({ analytics: { all: { summary_metrics: { IMPRESSION: 5400, OUTBOUND_CLICK: 31, SAVE: 88 }, daily_metrics: [] } } }),
      PINTEREST_GET_TOP_PINS: ok({ pins: [{ pin_id: "p1", metrics: { IMPRESSION: 900, SAVE: 20 } }], sort_by: "IMPRESSION" }),
    });
    const out = (await pinterestInsightsReadTool.execute(ctx, { days: 30 })) as Record<string, any>;
    expect(m.resolve).toHaveBeenCalledWith(TENANT, "pinterest");
    for (const c of m.exec.mock.calls) expect(c[0]).toMatchObject({ user_id: TENANT, connected_account_id: "ca_pin" });
    expect(m.exec.mock.calls[0][0].tool_slug).toBe("PINTEREST_GET_PROFILE");
    const analytics = m.exec.mock.calls.find((c) => c[0].tool_slug === "PINTEREST_GET_ACCOUNT_ANALYTICS")![0].arguments;
    expect(analytics.start_date).toBe(out.window.start_date);
    expect(analytics.end_date).toBe(out.window.end_date);
    expect(out.username).toBe("acme");
    expect(out.follower_count).toBe(120);
    expect(out.boards).toEqual([{ id: "971159175836868903", name: "Linen bedding", description: "Bedroom ideas", privacy: "PUBLIC", pin_count: 12 }]);
    expect(out.account_totals).toEqual({ IMPRESSION: 5400, OUTBOUND_CLICK: 31, SAVE: 88 });
    expect(out.top_pins).toEqual([{ pin_id: "p1", metrics: { IMPRESSION: 900, SAVE: 20 } }]);
    expect(out.provenance).toBe("owned");
  });

  it("reads the profile out of Composio's response_data and data wrappers, as the live account returns it", async () => {
    const profile = { username: "dudhat0633", account_type: "BUSINESS", follower_count: 12, pin_count: 7, board_count: 3, website_url: "https://dudhat.com" };
    for (const body of [{ response_data: profile }, JSON.stringify({ response_data: profile }), { data: profile }]) {
      route({
        PINTEREST_GET_PROFILE: ok(body),
        PINTEREST_LIST_BOARDS: ok({ items: [], bookmark: null }),
        PINTEREST_GET_ACCOUNT_ANALYTICS: ok({ analytics: { all: { summary_metrics: { IMPRESSION: 5400 } } } }),
        PINTEREST_GET_TOP_PINS: ok({ pins: [] }),
      });
      const out = (await pinterestInsightsReadTool.execute(ctx, {})) as Record<string, any>;
      expect(out).toMatchObject({
        username: "dudhat0633",
        account_type: "BUSINESS",
        website_url: "https://dudhat.com",
        follower_count: 12,
        pin_count: 7,
        board_count: 3,
        account_totals: { IMPRESSION: 5400 },
      });
      expect(out.note).toContain("@dudhat0633");
    }
  });

  it("keeps a failed section as its own error instead of failing the read", async () => {
    route({
      PINTEREST_GET_PROFILE: ok({ username: "acme" }),
      PINTEREST_LIST_BOARDS: ok({ items: [] }),
      PINTEREST_GET_ACCOUNT_ANALYTICS: { ok: false, status: 403, error: "business account required", data: null },
      PINTEREST_GET_TOP_PINS: ok({ pins: [] }),
    });
    const out = (await pinterestInsightsReadTool.execute(ctx, {})) as Record<string, any>;
    expect(out.account_totals).toBeNull();
    expect(out.account_error).toBe("business account required");
    expect(out.boards).toEqual([]);
  });

  it("refuses as not connected with the Connect-card meta when there is no Composio account", async () => {
    m.resolve.mockResolvedValue(null);
    await expect(pinterestInsightsReadTool.execute(ctx, {})).rejects.toMatchObject({
      code: "pinterest_not_connected",
      meta: { connector_slug: "composio.pinterest" },
    });
    expect(m.exec).not.toHaveBeenCalled();
  });

  it("an unreadable success body is a read error, never an empty account", async () => {
    route({
      PINTEREST_GET_PROFILE: ok({ username: "acme" }),
      PINTEREST_LIST_BOARDS: ok("not json"),
      PINTEREST_GET_ACCOUNT_ANALYTICS: ok({}),
      PINTEREST_GET_TOP_PINS: ok({ other: 1 }),
    });
    const out = (await pinterestInsightsReadTool.execute(ctx, {})) as Record<string, any>;
    expect(out.boards_error).toBe("pinterest_lookup_failed");
    expect(out.boards).toEqual([]);
    expect(out.boards_complete).toBe(false);
    expect(out.account_totals).toBeNull();
    expect(out.account_error).toBe("unexpected response shape");
    expect(out.top_pins_error).toBe("unexpected response shape");
  });
});

describe("pinterest_insights_read boards", () => {
  it("reads every page of boards, not just the first, and says the list is complete", async () => {
    const pages: Record<string, unknown> = {
      "": ok({ items: [{ id: "1", name: "Yoga", privacy: "PUBLIC", description: "Poses", pin_count: 3 }], bookmark: "bm1" }),
      bm1: ok({ items: [{ id: "2", name: "Cakes", privacy: "PUBLIC" }], bookmark: null }),
    };
    m.exec.mockImplementation(async (a: { tool_slug: string; arguments: { bookmark?: string } }) => {
      if (a.tool_slug === "PINTEREST_LIST_BOARDS") return pages[a.arguments.bookmark ?? ""];
      if (a.tool_slug === "PINTEREST_GET_PROFILE") return ok({ username: "acme" });
      return ok({});
    });
    const out = (await pinterestInsightsReadTool.execute(ctx, {})) as Record<string, any>;
    expect(out.boards).toEqual([
      { id: "1", name: "Yoga", description: "Poses", privacy: "PUBLIC", pin_count: 3 },
      { id: "2", name: "Cakes", description: null, privacy: "PUBLIC", pin_count: null },
    ]);
    expect(out.boards_complete).toBe(true);
    expect(out.boards_error).toBeNull();
  });

  it("an analytics read that never answers ends as that section's error, not a hung tool call", async () => {
    vi.useFakeTimers();
    try {
      m.exec.mockImplementation((a: { tool_slug: string }) => {
        if (a.tool_slug === "PINTEREST_GET_PROFILE") return Promise.resolve(ok({ username: "acme" }));
        if (a.tool_slug === "PINTEREST_LIST_BOARDS") return Promise.resolve(ok({ items: [], bookmark: null }));
        return new Promise(() => {});
      });
      const run = pinterestInsightsReadTool.execute(ctx, {}) as Promise<Record<string, any>>;
      await vi.advanceTimersByTimeAsync(31_000);
      const out = await run;
      expect(out.account_error).toBe("Pinterest did not answer in time");
      expect(out.top_pins_error).toBe("Pinterest did not answer in time");
    } finally {
      vi.useRealTimers();
    }
  });
});
