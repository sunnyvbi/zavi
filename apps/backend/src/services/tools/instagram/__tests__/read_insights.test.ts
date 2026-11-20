
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ proxy: vi.fn(), resolve: vi.fn(), token: vi.fn(), fetch: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: m.proxy }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.resolve }));
vi.mock("@/services/connectors/pipedream/api", () => ({
  proxyRequest: vi.fn(() => { throw new Error("pipedream must never be called"); }),
  listConnectedAccounts: vi.fn(() => { throw new Error("pipedream must never be called"); }),
}));

vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.token }));
import { instagramReadInsightsTool } from "../read_insights";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OWNED = { tenant_id: TENANT, toolkit: "instagram", connected_account_id: "ca_ig" };
const ctx = { tenant_id: TENANT, log: vi.fn() } as never;
const urlOf = (i: number) => new URL((m.proxy.mock.calls[i][0] as { endpoint: string }).endpoint);

beforeEach(() => {
  m.token.mockReset().mockResolvedValue(null);
  m.fetch.mockReset();
  vi.stubGlobal("fetch", m.fetch);
  m.proxy.mockReset();
  m.resolve.mockReset().mockResolvedValue(OWNED);
});

describe("instagram_read_insights (composio)", () => {
  it("reads profile, 28-day totals and per-post insights with 2026 metric names", async () => {
    m.proxy
      .mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "1789", username: "acme", followers_count: 1200, media_count: 80 } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [{ name: "reach", total_value: { value: 5400 } }, { name: "views", total_value: { value: 9100 } }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [
        { id: "p1", caption: "hook line", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-09-01T00:00:00+0000", permalink: "https://www.instagram.com/p/p1/", like_count: 40, comments_count: 3 },
        { id: "p2", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-02T00:00:00+0000" },
      ] } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [{ name: "views", values: [{ value: 800 }] }, { name: "saved", values: [{ value: 12 }] }, { name: "shares", values: [{ value: 5 }] }] } })
      .mockResolvedValueOnce({ ok: false, status: 400, json: { error: { message: "metric not supported", code: 100 } } });
    const out = (await instagramReadInsightsTool.execute(ctx, {})) as {
      username: string; followers_count: number; account_28d: Record<string, number>; items: Array<Record<string, unknown>>;
    };
    expect(m.resolve).toHaveBeenCalledWith(TENANT, "instagram");
    expect(out.username).toBe("acme");
    expect(out.followers_count).toBe(1200);
    expect(out.account_28d).toEqual({ reach: 5400, views: 9100 });
    expect(out.items[0]).toMatchObject({ id: "p1", media_product_type: "FEED", like_count: 40, insights: { views: 800, saved: 12, shares: 5 } });
    expect(out.items[1]).toMatchObject({ id: "p2", insights: null, insights_error: "metric not supported (code 100)" });
    for (const c of m.proxy.mock.calls) {
      expect(c[0].account).toBe(OWNED);
      expect(c[0].method).toBe("GET");
      expect(new URL(c[0].endpoint).hostname).toBe("graph.instagram.com");
    }
    expect(urlOf(0).pathname).toMatch(/\/me$/);
    expect(urlOf(1).pathname).toMatch(/\/1789\/insights$/);
    expect(urlOf(1).searchParams.get("metric")).not.toContain("impressions");
    expect(urlOf(1).searchParams.get("metric_type")).toBe("total_value");
    expect(urlOf(2).searchParams.get("limit")).toBe("25");
    expect(urlOf(3).searchParams.get("metric")).toBe("views,reach,saved,shares,likes,comments,total_interactions");
  });

  it("refuses with the composio connector slug when no owned account exists", async () => {
    m.resolve.mockResolvedValue(null);
    await expect(instagramReadInsightsTool.execute(ctx, {})).rejects.toMatchObject({
      code: "instagram_not_connected", meta: { connector_slug: "composio.instagram" },
    });
    expect(m.proxy).not.toHaveBeenCalled();
  });

  it("a refused profile read is a not-authorized error, not a throw of raw vendor data", async () => {
    m.proxy.mockResolvedValueOnce({ ok: false, status: 403, json: { error: { message: "denied" } } });
    await expect(instagramReadInsightsTool.execute(ctx, {})).rejects.toMatchObject({ code: "instagram_not_authorized" });
  });
});

it.each([{}, { data: null }, { data: {} }])("rejects malformed successful media responses: %j", async media => {
  m.proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "1789" } })
    .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [] } })
    .mockResolvedValueOnce({ ok: true, status: 200, json: media });
  await expect(instagramReadInsightsTool.execute(ctx, {})).rejects.toMatchObject({ code: "instagram_read_failed" });
});

it("reads a native Instagram connection when no Composio account exists", async () => {
  m.resolve.mockResolvedValue(null);
  m.token.mockResolvedValue("native-test-token");
  m.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "1789", username: "native" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
  const out = await instagramReadInsightsTool.execute(ctx, {}) as { username: string; items: unknown[] };
  expect(out.username).toBe("native");
  expect(m.token).toHaveBeenCalledWith(TENANT, "instagram_social", "instagram_social.access_token");
  expect(m.proxy).not.toHaveBeenCalled();
  expect(m.fetch).toHaveBeenCalledTimes(3);
  for (const [url, init] of m.fetch.mock.calls) {
    expect(new URL(url).hostname).toBe("graph.instagram.com");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer native-test-token");
  }
});

it("does not switch to a native account after the selected Composio account refuses", async () => {
  m.proxy.mockResolvedValueOnce({ ok: false, status: 403, json: { error: { message: "denied" } } });
  await expect(instagramReadInsightsTool.execute(ctx, {})).rejects.toMatchObject({ code: "instagram_not_authorized" });
  expect(m.token).not.toHaveBeenCalled(); expect(m.fetch).not.toHaveBeenCalled();
});

it("reports a native API refusal without exposing its credential", async () => {
  m.resolve.mockResolvedValue(null); m.token.mockResolvedValue("native-test-token");
  m.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 }));
  const error = (await instagramReadInsightsTool.execute(ctx, {}).catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "instagram_not_authorized" });
  expect(error.message).not.toContain("native-test-token");
});
