import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: vi.fn(async (tenant: string) => `token-${tenant}`),
  forceRefreshConnector: vi.fn(),
}));

import { countLinkedInAdsCalls, linkedinAdsBatchGet, linkedinAdsGet, resetLinkedInAdsReadCache } from "../http";
import { readLinkedInAdAnalyticsWithToken } from "../client";
import { assertPostFromPage, readCompanyPage, readPostForPage } from "../post-link";
import { linkedinCampaignMedia } from "@/services/campaign-media/linkedin";

const fetchMock = vi.fn();
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const day = (offset: number) => {
  const d = new Date(NOW + offset * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const urls = () => fetchMock.mock.calls.map((c) => decodeURIComponent(String(c[0])));
const tokens = () => fetchMock.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers.Authorization);

function batchAnswer(url: string) {
  const ids = [...decodeURIComponent(url).matchAll(/urn:li:[a-zA-Z]+:[\w-]+/g)].map((m) => m[0]);
  return ok({ results: Object.fromEntries(ids.map((id) => [id, { id, content: { media: { id: "urn:li:image:C1" } }, downloadUrl: `https://media.licdn.com/${id.split(":").pop()}.jpg` }])) });
}

beforeEach(() => {
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const analytics = (token: string, start: number, end: number, fresh?: boolean) =>
  readLinkedInAdAnalyticsWithToken(token, "42", { pivot: "CAMPAIGN", start: day(start), end: day(end), ...(fresh ? { fresh } : {}) });

it("a dashboard refresh within five minutes asks LinkedIn for neither the current nor the previous period again", async () => {
  fetchMock.mockImplementation(async () => ok({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:1"], costInLocalCurrency: "3" }] }));
  const open = () => Promise.all([analytics("tok", -30, 0), analytics("tok", -60, -31)]);
  const first = countLinkedInAdsCalls(open);
  await first.result;
  const second = countLinkedInAdsCalls(open);
  const [now] = await second.result;
  expect(first.calls).toEqual(["GET adAnalytics", "GET adAnalytics"]);
  expect(second.calls).toEqual([]);
  expect(now[0].spend).toBe(3);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("re-asks for a range that includes today after five minutes, for yesterday after thirty, and for an older closed range after six hours", async () => {
  fetchMock.mockImplementation(async () => ok({ elements: [] }));
  const all = () => Promise.all([analytics("tok", -7, 0), analytics("tok", -7, -1), analytics("tok", -20, -10)]);
  await all();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  vi.setSystemTime(NOW + 5 * 60_000 + 1);
  await all();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  vi.setSystemTime(NOW + 30 * 60_000 + 1);
  await all();
  expect(fetchMock).toHaveBeenCalledTimes(6);
  vi.setSystemTime(NOW + 6 * 3600_000 + 1);
  await all();
  expect(fetchMock).toHaveBeenCalledTimes(9);
});

it("never serves one token's analytics to another token, even for the same account and dates", async () => {
  fetchMock.mockImplementation(async (_u: string, init: { headers: Record<string, string> }) => ok({ elements: [{ pivotValues: [init.headers.Authorization], costInLocalCurrency: "1" }] }));
  const a = await analytics("tenant-a", -7, -1);
  const b = await analytics("tenant-b", -7, -1);
  expect(a[0].pivot).toBe("Bearer tenant-a");
  expect(b[0].pivot).toBe("Bearer tenant-b");
  expect(tokens()).toEqual(["Bearer tenant-a", "Bearer tenant-b"]);
});

it("money reads ask LinkedIn every time and leave the newest answer for later page loads", async () => {
  let spend = 1;
  fetchMock.mockImplementation(async () => ok({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:1"], costInLocalCurrency: String(spend++) }] }));
  expect((await analytics("tok", -30, 0))[0].spend).toBe(1);
  expect((await analytics("tok", -30, 0, true))[0].spend).toBe(2);
  expect((await analytics("tok", -30, 0, true))[0].spend).toBe(3);
  expect((await analytics("tok", -30, 0))[0].spend).toBe(3);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("an analytics query with no date range is never cached", async () => {
  fetchMock.mockImplementation(async () => ok({ elements: [] }));
  await linkedinAdsGet("tok", "adAnalytics", { q: "analytics" });
  await linkedinAdsGet("tok", "adAnalytics", { q: "analytics" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("batch-reads only the posts it has not seen, per token, and never caches a post LinkedIn did not return", async () => {
  fetchMock.mockImplementation(async (url: string) => (url.includes("urn%3Ali%3Ashare%3A3") ? ok({ results: {} }) : batchAnswer(url)));
  const first = await linkedinAdsBatchGet("tok", "posts", ["urn:li:share:1", "urn:li:share:2"]);
  expect(Object.keys(first).sort()).toEqual(["urn:li:share:1", "urn:li:share:2"]);
  const second = await linkedinAdsBatchGet("tok", "posts", ["urn:li:share:2", "urn:li:share:1", "urn:li:ugcPost:4"]);
  expect(Object.keys(second).sort()).toEqual(["urn:li:share:1", "urn:li:share:2", "urn:li:ugcPost:4"]);
  expect(urls()[1]).toContain("urn:li:ugcPost:4");
  expect(urls()[1]).not.toContain("urn:li:share:1");
  await linkedinAdsBatchGet("tok", "posts", ["urn:li:share:3"]);
  await linkedinAdsBatchGet("tok", "posts", ["urn:li:share:3"]);
  await linkedinAdsBatchGet("other", "posts", ["urn:li:share:1"]);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(tokens()[4]).toBe("Bearer other");
  expect(fetchMock.mock.calls.every((c) => (c[1] as { headers: Record<string, string> }).headers["X-RestLi-Method"] === "BATCH_GET")).toBe(true);
  vi.setSystemTime(NOW + 10 * 60_000 + 1);
  await linkedinAdsBatchGet("tok", "posts", ["urn:li:share:1"]);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it("does not keep an image whose signed download link is about to expire", async () => {
  fetchMock.mockImplementation(async () => ok({ results: { "urn:li:image:A": { downloadUrl: "https://media.licdn.com/a.jpg", downloadUrlExpiresAt: NOW + 30_000 }, "urn:li:image:B": { downloadUrl: "https://media.licdn.com/b.jpg", downloadUrlExpiresAt: NOW + 86_400_000 } } }));
  await linkedinAdsBatchGet("tok", "images", ["urn:li:image:A", "urn:li:image:B"]);
  await linkedinAdsBatchGet("tok", "images", ["urn:li:image:A", "urn:li:image:B"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(urls()[1]).toContain("urn:li:image:A");
  expect(urls()[1]).not.toContain("urn:li:image:B");
});

it("a second thumbnail load with one more campaign reads LinkedIn only for what is new", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/adAccounts\?/.test(url)) return ok({ elements: [{ id: 42, name: "A" }] });
    if (url.includes("/creatives?")) {
      const ids = [...decodeURIComponent(url).matchAll(/sponsoredCampaign:(\d+)/g)].map((m) => m[1]);
      return ok({ elements: ids.map((id) => ({ campaign: `urn:li:sponsoredCampaign:${id}`, content: { reference: `urn:li:share:${id}` } })) });
    }
    return batchAnswer(url);
  });
  const first = countLinkedInAdsCalls(() => linkedinCampaignMedia("tenant", ["1", "2"]));
  const shown = await first.result;
  expect(shown["1"]).toEqual(["https://media.licdn.com/1.jpg", "https://media.licdn.com/C1.jpg"]);
  expect(first.calls).toEqual(["GET adAccounts", "GET adAccounts", "GET posts", "GET images"]);
  const again = countLinkedInAdsCalls(() => linkedinCampaignMedia("tenant", ["1", "2"]));
  expect(await again.result).toEqual(shown);
  expect(again.calls).toEqual([]);
  const more = countLinkedInAdsCalls(() => linkedinCampaignMedia("tenant", ["1", "2", "3"]));
  await more.result;
  expect(more.calls).toEqual(["GET adAccounts", "GET posts"]);
  expect(urls().filter((u) => u.includes("/posts?")).at(-1)).toContain("urn:li:share:3");
  expect(urls().filter((u) => u.includes("/posts?")).at(-1)).not.toContain("urn:li:share:1");
});

it("a post preview reuses a recent read, but the author check before a campaign is created always asks LinkedIn", async () => {
  let author = "urn:li:organization:9";
  fetchMock.mockImplementation(async (url: string) => (url.includes("/posts/") ? ok({ author, commentary: "hi" }) : ok({ localizedName: "Acme" })));
  await readPostForPage("tok", "urn:li:share:7", "urn:li:organization:9");
  await readPostForPage("tok", "urn:li:share:7", "urn:li:organization:9");
  await readCompanyPage("tok", "urn:li:organization:9");
  await readCompanyPage("tok", "urn:li:organization:9");
  expect(urls().filter((u) => u.includes("/posts/"))).toHaveLength(1);
  expect(urls().filter((u) => u.includes("/organizations/"))).toHaveLength(2);
  author = "urn:li:person:abc";
  expect(await assertPostFromPage("tok", "urn:li:share:7", "urn:li:organization:9")).toBe("member");
  expect(await assertPostFromPage("tok", "urn:li:share:7", "urn:li:organization:9")).toBe("member");
  expect(urls().filter((u) => u.includes("/posts/"))).toHaveLength(3);
});
