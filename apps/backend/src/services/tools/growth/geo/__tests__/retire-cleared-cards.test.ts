import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn() }));

import { clearedCardIds, readinessCitations, retireClearedGeoCards, type OpenGeoCard, type ReadinessRead } from "../retire-cleared-cards";

const SITE = "https://www.example.com";
const read = (over: Partial<ReadinessRead> = {}): ReadinessRead => ({
  status: "ok",
  fetched_at: "2026-10-23T07:58:42Z",
  findings: [{ code: "no_lead_passage", urls: [`${SITE}/pricing`] }],
  pages: ["/", "/search", "/listing", "/pricing"].map((p) => ({ url: `${SITE}${p}` })),
  ...over,
});
const card = (evidence: string[], over: Partial<OpenGeoCard> = {}): OpenGeoCard => ({
  id: "c1",
  proposed_at: "2026-10-12T00:56:00Z",
  evidence,
  ...over,
});
const RENDER = [
  `growth__geo_readiness: geo_not_server_rendered on ${SITE}/listing (28 words) and ${SITE}/search (49 words)`,
  "growth__seo_audit: thin_server_html on both URLs",
];

describe("readinessCitations", () => {
  it("reads the finding codes and the pages a readiness line names", () => {
    expect(readinessCitations(RENDER)).toEqual([{ codes: ["geo_not_server_rendered"], paths: ["/listing", "/search"] }]);
    expect(readinessCitations(["growth__geo_readiness: no_lead_passage flagged on /pricing."])).toEqual([
      { codes: ["no_lead_passage"], paths: ["/pricing"] },
    ]);
  });

  it("ignores other tools and words that are not finding codes", () => {
    expect(readinessCitations(["growth__seo_audit: geo_not_server_rendered on /x", "growth__geo_readiness: some_other_thing"])).toEqual([]);
  });
});

describe("clearedCardIds", () => {
  it("closes a card whose cited finding a newer read no longer reports on the pages it names", () => {
    expect(clearedCardIds([card(RENDER)], read())).toEqual(["c1"]);
  });

  it("keeps it while the finding is still reported on one of its pages", () => {
    const r = read({ findings: [{ code: "geo_not_server_rendered", urls: [`${SITE}/search`] }] });
    expect(clearedCardIds([card(RENDER)], r)).toEqual([]);
  });

  it("keeps it when the read did not fetch a page it names: unknown is not fixed", () => {
    const r = read({ pages: [{ url: `${SITE}/` }, { url: `${SITE}/search` }] });
    expect(clearedCardIds([card(RENDER)], r)).toEqual([]);
  });

  it("keeps a card citing no readiness finding, and one filed after the read", () => {
    expect(clearedCardIds([card(["web_fetch: hero reads X"])], read())).toEqual([]);
    expect(clearedCardIds([card(RENDER, { proposed_at: "2026-10-24T00:00:00Z" })], read())).toEqual([]);
  });

  it("keeps every card when the read itself failed", () => {
    expect(clearedCardIds([card(RENDER)], read({ status: "error" }))).toEqual([]);
  });

  it("with no page named, closes only when the finding is gone from the whole read", () => {
    const c = card(["growth__geo_readiness: no_lead_passage on 11 pages"]);
    expect(clearedCardIds([c], read())).toEqual([]);
    expect(clearedCardIds([c], read({ findings: [] }))).toEqual(["c1"]);
  });
});

describe("retireClearedGeoCards", () => {
  it("retires what the read contradicts and never throws", async () => {
    const retire = vi.fn(async (_t: string, ids: string[]) => ids);
    const out = await retireClearedGeoCards("t1", read(), { openCards: async () => [card(RENDER)], retire });
    expect(out).toEqual(["c1"]);
    expect(retire).toHaveBeenCalledWith("t1", ["c1"], "2026-10-23T07:58:42Z");
    const failing = await retireClearedGeoCards("t1", read(), {
      openCards: async () => {
        throw new Error("db down");
      },
      retire,
    });
    expect(failing).toEqual([]);
  });
});
