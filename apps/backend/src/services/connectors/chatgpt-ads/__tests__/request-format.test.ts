import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ platformSecretRpc: vi.fn(async () => ({ data: "vault-key", error: null })) }));
import { getChatgptAdsCampaignInsights, timeRangeParam } from "../client";
import { getChatgptAdsApiKey, __resetChatgptAdsKeyCacheForTests } from "../key-provider";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __resetChatgptAdsKeyCacheForTests(); });
describe("live-verified Ads API request format", () => {
  it("encodes a bounded JSON unix window ending at a complete hour", () => {
    const range = JSON.parse(timeRangeParam(7, new Date("2026-09-24T12:34:56Z")));
    expect(range.type).toBe("unix_range"); expect(range.end - range.start).toBe(7 * 86400);
    expect(new Date(range.end * 1000).toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });
  it("uses bracket arrays and explicitly requests the metrics", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ data: [] }))); vi.stubGlobal("fetch", fetch);
    await getChatgptAdsCampaignInsights("private-key", "a/b", timeRangeParam(14));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/campaigns/a%2Fb/insights");
    expect(url.searchParams.has("time_ranges[]")).toBe(true);
    expect(url.searchParams.getAll("fields[]")).toContain("campaign.spend");
    expect(url.searchParams.getAll("includes[]")).toEqual(["zero_impression_items"]);
    expect(url.toString()).not.toContain("private-key");
  });
  it("honors the server environment override before the vault cache", async () => {
    vi.stubEnv("OPENAI_ADS_API_KEY", " test-key "); expect(await getChatgptAdsApiKey()).toBe("test-key");
    vi.stubEnv("OPENAI_ADS_API_KEY", ""); expect(await getChatgptAdsApiKey()).toBe("vault-key");
  });
  it("refuses truncated insights instead of returning a partial total", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ spend: 1 }], has_more: true })));
    await expect(getChatgptAdsCampaignInsights("key", "c1", timeRangeParam(7))).rejects.toThrow("Incomplete");
  });
});

it("sends the idempotency key in a create header without changing the payload", async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ id: "c1" })));
  vi.stubGlobal("fetch", fetch);
  const { chatgptAdsPost } = await import("../http");
  await chatgptAdsPost("key", "/campaigns", { name: "Launch" }, "stable-request");
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ "Idempotency-Key": "stable-request" });
  expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ name: "Launch" }));
});

it("tracks actual POST attempts through nested callers, but no read or local refusal", async () => {
  const { withChatgptWriteTracking } = await import("../write-tracking");
  const { chatgptAdsPost, chatgptAdsGet } = await import("../http");
  const outer = vi.fn(), inner = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  await withChatgptWriteTracking(outer, async () => {
    await chatgptAdsGet("key", "/ad_account");
    expect(outer).not.toHaveBeenCalled();
    await expect(withChatgptWriteTracking(inner, async () => { throw new Error("preflight"); })).rejects.toThrow("preflight");
    expect(inner).not.toHaveBeenCalled();
    await withChatgptWriteTracking(inner, () => chatgptAdsPost("key", "/campaigns/cmpn_test", { status: "active" }));
  });
  expect(outer).toHaveBeenCalledTimes(1); expect(inner).toHaveBeenCalledTimes(1);
});
