import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLinkedInAdsCalls, linkedinAdsGet, resetLinkedInAdsReadCache, LINKEDIN_ADS_BUSY, LINKEDIN_ADS_DAILY_LIMIT } from "../http";

const fetchMock = vi.fn();
let release: Array<() => void> = [];

function ok(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}
function fail(status: number, headers: Record<string, string> = {}, message = "") {
  return { ok: false, status, headers: new Headers(headers), json: async () => ({ message }), text: async () => JSON.stringify({ message }) };
}

beforeEach(() => {
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  release = [];
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_CACHE_FILE;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("asks LinkedIn once when a review open and a keystroke race for the same facet list and account", async () => {
  fetchMock.mockImplementation((url: string) => new Promise(resolve => release.push(() => resolve(ok({ url })))));
  const reads = [
    linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:seniorities" }),
    linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:seniorities" }),
    linkedinAdsGet("tok", "adAccounts/559148166"),
    linkedinAdsGet("tok", "adAccounts/559148166"),
    linkedinAdsGet("tok", "adAccounts", { q: "search" }),
    linkedinAdsGet("tok", "adAccounts", { q: "search" }),
  ];
  expect(fetchMock).toHaveBeenCalledTimes(3);
  release.forEach(r => r());
  const [a, b, c, d, e, f] = await Promise.all(reads);
  expect(a).toEqual(b);
  expect(c).toEqual(d);
  expect(e).toEqual(f);
  fetchMock.mockImplementation(async (url: string) => ok({ url }));
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "typeahead", facet: "urn:li:adTargetingFacet:titles", query: "Chief" });
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "typeahead", facet: "urn:li:adTargetingFacet:titles", query: "Chief" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "typeahead", facet: "urn:li:adTargetingFacet:titles", query: "Chief F" });
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("never shares one customer's LinkedIn answer with another token", async () => {
  fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => ok({ who: init.headers.Authorization }));
  const mine = await linkedinAdsGet<{ who: string }>("tenant-a", "adAccounts/1");
  const theirs = await linkedinAdsGet<{ who: string }>("tenant-b", "adAccounts/1");
  expect(mine.who).toBe("Bearer tenant-a");
  expect(theirs.who).toBe("Bearer tenant-b");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("re-reads write-time checks, roles, campaigns and analytics every time", async () => {
  fetchMock.mockImplementation(async () => ok({ elements: [] }));
  for (let i = 0; i < 2; i++) {
    await linkedinAdsGet("tok", "adTargetingEntities", { q: "urns", urns: ["urn:li:geo:1"] });
    await linkedinAdsGet("tok", "adAccountUsers", { q: "accounts", accounts: "urn:li:sponsoredAccount:1" });
    await linkedinAdsGet("tok", "adAccounts/1/adCampaigns", { q: "search" });
    await linkedinAdsGet("tok", "adAnalytics", { q: "analytics" });
  }
  expect(fetchMock).toHaveBeenCalledTimes(8);
});

it("does not remember a failure, so the next open asks LinkedIn again", async () => {
  fetchMock.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok({ id: 1 }));
  await expect(linkedinAdsGet("tok", "adAccounts/1")).rejects.toThrow();
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("expires account reads after five minutes but keeps the facet list for the day", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  fetchMock.mockImplementation(async () => ok({}));
  await linkedinAdsGet("tok", "adAccounts/1");
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:industries" });
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
  await linkedinAdsGet("tok", "adAccounts/1");
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:industries" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("stops calling LinkedIn for that token after a 429 until Retry-After passes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  fetchMock.mockResolvedValueOnce(fail(429, { "retry-after": "30" })).mockImplementation(async () => ok({}));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAccounts/1")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(linkedinAdsGet("other", "adAccounts/1")).resolves.toEqual({});
  vi.setSystemTime(Date.now() + 30_001);
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("still serves a cached account read while that token is cooling down after a 429", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  fetchMock.mockResolvedValueOnce(ok({ id: 1, name: "Acme" })).mockResolvedValueOnce(fail(429, { "retry-after": "30" }));
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1, name: "Acme" });
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1, name: "Acme" });
  await expect(linkedinAdsGet("tok", "adAccounts/2")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAccounts/1", {}, {}, { fresh: true })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("stops every token reading that resource until UTC midnight after LinkedIn says the app's daily limit is spent", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle APPLICATION DAY limit for calls to this resource is reached."))
    .mockImplementation(async () => ok({}));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  vi.setSystemTime(new Date("2026-10-29T23:59:59Z"));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("other", "adAnalytics", { q: "statistics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date("2026-10-30T00:00:01Z"));
  await expect(linkedinAdsGet("other", "adAnalytics", { q: "analytics" })).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("stops only that member's token for the day when LinkedIn says the member's daily limit is spent", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle MEMBER DAY limit for calls to this resource is reached."))
    .mockImplementation(async () => ok({}));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  vi.setSystemTime(new Date("2026-10-29T20:00:00Z"));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(linkedinAdsGet("other", "adAnalytics", { q: "analytics" })).resolves.toEqual({});
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("treats LinkedIn's per-app-and-member daily limit as spent for that token until UTC midnight, and says so", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T18:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle APPLICATION_AND_MEMBER DAY limit for calls to this resource is reached."))
    .mockImplementation(async () => ok({}));
  const first = await linkedinAdsGet("tok", "adAnalytics", { q: "analytics" }).catch((e: Error) => e);
  expect((first as Error).message).toBe(LINKEDIN_ADS_DAILY_LIMIT);
  expect((first as Error).message).not.toContain("few minutes");
  vi.setSystemTime(new Date("2026-10-29T23:30:00Z"));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(linkedinAdsGet("other", "adAnalytics", { q: "analytics" })).resolves.toEqual({});
  vi.setSystemTime(new Date("2026-10-30T00:00:01Z"));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("doubles the pause on each repeated short 429 without Retry-After, capped at an hour", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock.mockImplementation(async () => fail(429));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  vi.setSystemTime(Date.now() + 60_001);
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 60_001);
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 60_000);
  fetchMock.mockImplementation(async () => ok({}));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("keeps cached reads and a daily block across a backend restart", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  const file = join(mkdtempSync(join(tmpdir(), "li-cache-")), "store.json");
  process.env.LINKEDIN_ADS_CACHE_FILE = file;
  fetchMock
    .mockResolvedValueOnce(ok({ elements: [{ id: 1 }] }))
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle APPLICATION_AND_MEMBER DAY limit for calls to this resource is reached."));
  await linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:seniorities" });
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  vi.advanceTimersByTime(600);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain("tok\"");
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok({ elements: [] }));
  await expect(linkedinAdsGet("tok", "adTargetingEntities", { q: "adTargetingFacet", facet: "urn:li:adTargetingFacet:seniorities" })).resolves.toEqual({ elements: [{ id: 1 }] });
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-10-30T00:00:01Z"));
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).resolves.toEqual({ elements: [] });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("asks LinkedIn again on a fresh read even when the account is cached, and later reads see the fresh answer", async () => {
  fetchMock.mockResolvedValueOnce(ok({ id: 1, status: "ACTIVE" })).mockResolvedValueOnce(ok({ id: 1, status: "CANCELED" }));
  await linkedinAdsGet("tok", "adAccounts/1");
  await expect(linkedinAdsGet("tok", "adAccounts/1", {}, {}, { fresh: true })).resolves.toEqual({ id: 1, status: "CANCELED" });
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1, status: "CANCELED" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("counts only the calls that reached LinkedIn inside one request", async () => {
  fetchMock.mockImplementation(async () => ok({}));
  const { calls, result } = countLinkedInAdsCalls(async () => {
    await linkedinAdsGet("tok", "adAccounts/1");
    await linkedinAdsGet("tok", "adAccounts/1");
    await linkedinAdsGet("tok", "adAnalytics", { q: "analytics" });
  });
  await result;
  expect(calls).toEqual(["GET adAccounts", "GET adAnalytics"]);
});

it("a daily limit on the account list blocks only that endpoint and method, never the campaign read a pause needs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle MEMBER DAY limit for calls to this resource is reached."))
    .mockImplementation(async () => ok({ id: 77 }));
  await expect(linkedinAdsGet("tok", "adAccounts", { q: "search" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns/77")).resolves.toEqual({ id: 77 });
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns", { q: "search" })).resolves.toEqual({ id: 77 });
  await expect(linkedinAdsGet("tok", "adAccounts/1", {}, {}, { fresh: true })).resolves.toEqual({ id: 77 });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await expect(linkedinAdsGet("tok", "adAccounts", { q: "search", pageToken: "p2" })).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("a daily limit on one campaign's read is shared by every campaign of that endpoint, since LinkedIn counts the endpoint", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle APPLICATION DAY limit for calls to this resource is reached."))
    .mockImplementation(async () => ok({}));
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns/77")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("other", "adAccounts/2/adCampaigns/88")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(linkedinAdsGet("other", "adAccounts/2/adCampaigns", { q: "search" })).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("a pause-critical read bypasses the local daily block, the token's cool-down and the cache, so a pause can still see the campaign", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  fetchMock
    .mockResolvedValueOnce(ok({ id: 1, status: "ACTIVE" }))
    .mockResolvedValueOnce(fail(429, {}, "Resource level throttle APPLICATION DAY limit for calls to this resource is reached."))
    .mockResolvedValueOnce(fail(429, { "retry-after": "600" }))
    .mockResolvedValueOnce(ok({ id: 77, status: "ACTIVE" }))
    .mockResolvedValueOnce(ok({ id: 1, status: "CANCELED" }));
  await linkedinAdsGet("tok", "adAccounts/1");
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns/77")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns/77")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("tok", "adAccounts/2")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1, status: "ACTIVE" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await expect(linkedinAdsGet("tok", "adAccounts/1/adCampaigns/77", {}, {}, { pauseCritical: true })).resolves.toEqual({ id: 77, status: "ACTIVE" });
  await expect(linkedinAdsGet("tok", "adAccounts/1", {}, {}, { pauseCritical: true })).resolves.toEqual({ id: 1, status: "CANCELED" });
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("an empty audience lookup is asked again, and a lookup with answers stays cached", async () => {
  const typeahead = { q: "typeahead", query: "zz" };
  fetchMock.mockResolvedValueOnce(ok({ elements: [] })).mockResolvedValue(ok({ elements: [{ urn: "urn:li:title:1" }] }));
  await expect(linkedinAdsGet("tok", "adTargetingEntities", typeahead)).resolves.toEqual({ elements: [] });
  await new Promise((r) => setTimeout(r, 0));
  await expect(linkedinAdsGet("tok", "adTargetingEntities", typeahead)).resolves.toEqual({ elements: [{ urn: "urn:li:title:1" }] });
  await new Promise((r) => setTimeout(r, 0));
  await linkedinAdsGet("tok", "adTargetingEntities", typeahead);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("Review 31 P1: a burst of parallel 429s counts as one strike, so the pause stays one minute, not four", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  fetchMock.mockImplementation(async () => fail(429));
  const burst = await Promise.allSettled(["adAccounts/1", "adAccounts/2", "adAccounts/3", "adAccounts/4"].map((p) => linkedinAdsGet("tok", p)));
  expect(burst.every((r) => r.status === "rejected")).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  fetchMock.mockImplementation(async () => ok({ id: 9 }));
  vi.setSystemTime(new Date("2026-11-03T10:00:59Z"));
  await expect(linkedinAdsGet("tok", "adAccounts/9")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  vi.setSystemTime(new Date("2026-11-03T10:01:00.001Z"));
  await expect(linkedinAdsGet("tok", "adAccounts/9")).resolves.toEqual({ id: 9 });
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("Review 31 P1: a success after a pause resets the count, so the next 429 pauses one minute again, not two", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok({ id: 1 })).mockResolvedValueOnce(fail(429)).mockImplementation(async () => ok({ id: 2 }));
  await expect(linkedinAdsGet("tok", "adAccounts/1")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  vi.setSystemTime(new Date("2026-11-03T10:01:00.001Z"));
  await expect(linkedinAdsGet("tok", "adAccounts/1")).resolves.toEqual({ id: 1 });
  await expect(linkedinAdsGet("tok", "adAnalytics", { q: "analytics" })).rejects.toThrow(LINKEDIN_ADS_BUSY);
  vi.setSystemTime(new Date("2026-11-03T10:02:00.002Z"));
  await expect(linkedinAdsGet("tok", "adAccounts/2")).resolves.toEqual({ id: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("Review 31 P1: the shared wallet login's pause never blocks a founder's own login, and back", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  fetchMock.mockImplementation(async (href: string) => (String(href).includes("adAccounts/1") ? fail(429, { "retry-after": "600" }) : ok({ id: 2 })));
  await expect(linkedinAdsGet("wallet-token", "adAccounts/1")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  await expect(linkedinAdsGet("founder-token", "adAccounts/2")).resolves.toEqual({ id: 2 });
  await expect(linkedinAdsGet("wallet-token", "adAccounts/2")).rejects.toThrow(LINKEDIN_ADS_BUSY);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("Review 31 P5: a 429 and every read refused during its pause carry the time Zavi will ask LinkedIn again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  fetchMock.mockResolvedValueOnce(fail(429, { "retry-after": "900" }));
  const first = (await linkedinAdsGet("tok", "adAccounts/1").catch((e) => e)) as { meta?: unknown };
  expect(first.meta).toMatchObject({ http_status: 429, retry_at: "2026-11-03T10:15:00.000Z" });
  vi.setSystemTime(new Date("2026-11-03T10:05:00Z"));
  const later = (await linkedinAdsGet("tok", "adAccounts/2").catch((e) => e)) as { meta?: unknown };
  expect(later.meta).toMatchObject({ http_status: 429, retry_at: "2026-11-03T10:15:00.000Z" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
