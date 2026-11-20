import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  rows: {} as Record<string, { team_id: string; composio_auth_config_id: string } | undefined>,
  verify: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      let slug = "";
      const q: any = {
        select: () => q,
        eq: (col: string, v: string) => { if (col === "slug") slug = v; return q; },
        maybeSingle: async () => ({ data: m.rows[slug] ?? null, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/connectors/composio/api", async (orig) => ({ ...(await orig<object>()), composioVerifyActive: m.verify, composioGetAccount: m.get }));
vi.mock("@/services/connectors/composio/catalog", () => ({ lookupAuthConfigId: async () => "ac_x" }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async (_t: string, key: string) => (/property/.test(key) ? "properties/123" : null) }));

import { callRedditAdsTool } from "../reddit-ads";
import { callTikTokAdsTool } from "../tiktok-ads";
import { callPinterestInsightsTool } from "../pinterest-insights";
import { callGoogleAnalyticsTool } from "../google-analytics";

const T = "11111111-1111-4111-8111-111111111111";
const expired = { status: "EXPIRED", status_reason: "Access revoked; Details: Bad Request 400", updated_at: "2026-10-15T15:07:09Z", user_id: T };

beforeEach(() => {
  m.rows = {};
  m.verify.mockReset().mockResolvedValue(false);
  m.get.mockReset().mockResolvedValue(expired);
});

const body = (r: { content: unknown }) => JSON.parse(String(r.content)) as { error: string; message: string; meta?: Record<string, unknown> };

describe("Reddit Ads agent tool on a stopped Composio login", () => {
  it("set up but EXPIRED: connection_stopped with the date, a Reconnect card slug, no blame", async () => {
    m.rows["composio.reddit_ads"] = { team_id: "ca_r", composio_auth_config_id: "ac_r" };
    const r = await callRedditAdsTool({ tenant_id: T }, "list_accounts", {});
    expect(r.is_error).toBe(true);
    const b = body(r);
    expect(b.error).toBe("reddit_ads_connection_stopped");
    expect(b.message).toBe("Reddit Ads connection stopped working on Oct 15. Reconnect it.");
    expect(b.message).not.toMatch(/not connected|revoked/i);
    expect(b.meta).toMatchObject({ connector_slug: "reddit_ads", connector_mode: "reconnect" });
    expect(m.get).toHaveBeenCalledWith("ca_r");
  });

  it("never connected (no row): reddit_ads_not_connected stays, no Composio status read", async () => {
    const r = await callRedditAdsTool({ tenant_id: T }, "list_accounts", {});
    expect(body(r).error).toBe("reddit_ads_not_connected");
    expect(m.get).not.toHaveBeenCalled();
  });

  it("set up, but Composio's status read fails: connection_unverified, never \"not connected\"", async () => {
    m.rows["composio.reddit_ads"] = { team_id: "ca_r", composio_auth_config_id: "ac_r" };
    m.get.mockRejectedValue(new Error("composio get account HTTP 503"));
    const b = body(await callRedditAdsTool({ tenant_id: T }, "list_accounts", {}));
    expect(b.error).toBe("reddit_ads_connection_unverified");
    expect(b.message).toBe("Reddit Ads is set up, but Zavi could not check its login just now. Try again shortly; if it keeps failing, reconnect it.");
  });
});

describe("TikTok Ads agent tool on a stopped Composio login", () => {
  it("set up but EXPIRED: tiktok_ads_connection_stopped", async () => {
    m.rows["composio.tiktok_ads"] = { team_id: "ca_t", composio_auth_config_id: "ac_t" };
    const b = body(await callTikTokAdsTool({ tenant_id: T }, "list_accounts", {}));
    expect(b.error).toBe("tiktok_ads_connection_stopped");
    expect(b.message).toBe("TikTok Ads connection stopped working on Oct 15. Reconnect it.");
  });
  it("never connected: tiktok_ads_not_connected", async () => {
    expect(body(await callTikTokAdsTool({ tenant_id: T }, "list_accounts", {})).error).toBe("tiktok_ads_not_connected");
  });
});

describe("the same helper on the other Composio-rail reads", () => {
  it("Pinterest insights: pinterest_connection_stopped names composio.pinterest for the card", async () => {
    m.rows["composio.pinterest"] = { team_id: "ca_p", composio_auth_config_id: "ac_p" };
    const b = body(await callPinterestInsightsTool({ tenant_id: T }, "read", {}));
    expect(b.error).toBe("pinterest_connection_stopped");
    expect(b.message).toBe("Pinterest connection stopped working on Oct 15. Reconnect it.");
    expect(b.meta).toMatchObject({ connector_slug: "composio.pinterest", connector_mode: "reconnect" });
  });
  it("Google Analytics: EXPIRED -> connection_stopped; an ACTIVE account keeps the tool's own error", async () => {
    m.rows["composio.google_analytics"] = { team_id: "ca_g", composio_auth_config_id: "ac_g" };
    const args = {};
    expect(body(await callGoogleAnalyticsTool({ tenant_id: T }, "run_report", args)).error).toBe("google_analytics_connection_stopped");
    m.get.mockResolvedValue({ ...expired, status: "ACTIVE" });
    expect(body(await callGoogleAnalyticsTool({ tenant_id: T }, "run_report", args)).error).toBe("google_analytics_not_connected");
  });
});
