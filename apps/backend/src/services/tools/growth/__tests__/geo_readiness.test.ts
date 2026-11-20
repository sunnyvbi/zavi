import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeGeo, type GeoAuditInput } from "../geo/analyze";
import type { GeoReadiness } from "../seo/snapshot";

const getGeoReadiness = vi.fn();
vi.mock("../seo/snapshot", async (orig) => ({
  ...(await orig<typeof import("../seo/snapshot")>()),
  getGeoReadiness: (...a: unknown[]) => getGeoReadiness(...a),
}));

import { callGrowthTool, listGrowthTools } from "@/services/mcp/internal/growth";
import { geoReadinessTool, slimReadiness } from "../geo_readiness";

const CTX_TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

const BODY = `<p>${"Plain words about the service a visitor can read without scripts. ".repeat(12)}</p>`;

type FetchedPage = GeoAuditInput["pages"][number];

function page(path: string): FetchedPage {
  return {
    url: `https://example.com${path}`,
    status: 200,
    html: `<html><head><title>t</title><script type="application/ld+json">{"@type":"Organization"}</script></head><body><h1>Service</h1>${BODY}</body></html>`,
  } as FetchedPage;
}

function readiness(robotsBody: string | null, robotsFetched = true): GeoReadiness {
  const geo = analyzeGeo({
    pages: [page("/"), page("/pricing")],
    robotsBody,
    robotsFetched,
    llmsTxt: false,
    pagesPlanned: 2,
  });
  return { status: "ok", site: "https://example.com", error_code: null, fetched_at: "2026-10-10T00:00:00.000Z", stale: false, notes: [], ...geo };
}

function slim(r: GeoReadiness) {
  const out = slimReadiness(r);
  if (!out.checked) throw new Error("expected a checked result");
  return out;
}

const stateOf = (out: ReturnType<typeof slim>, name: string) => out.crawlers.find((c) => c.name === name);

beforeEach(() => getGeoReadiness.mockReset());

describe("growth geo_readiness tool", () => {
  it("is advertised on the growth facade as a read", () => {
    const t = listGrowthTools().find((x) => x.tool_name === "geo_readiness");
    expect(t?.effect).toBe("read");
  });

  it("reads the run's tenant, never one named in the input", async () => {
    getGeoReadiness.mockResolvedValue(readiness("User-agent: *\nAllow: /\n"));
    const res = await callGrowthTool(CTX_TENANT, "geo_readiness", { tenant_id: OTHER_TENANT });
    expect(res.ok).toBe(true);
    expect(getGeoReadiness).toHaveBeenCalledTimes(1);
    expect(getGeoReadiness.mock.calls[0][0]).toBe(CTX_TENANT);
  });

  it("a site open to the training bot and closed to the search bot reads as citation-blocked", () => {
    const out = slim(readiness("User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n"));
    const search = stateOf(out, "OAI-SearchBot");
    expect(search).toMatchObject({ state: "blocked", class: "search", governs_citation: true });
    expect(search?.directive).toMatch(/Disallow/i);
    expect(stateOf(out, "GPTBot")).toMatchObject({ state: "allowed", class: "training", governs_citation: false });
    expect(out.findings.some((f) => f.code === "ai_crawler_blocked")).toBe(true);
  });

  it("a clean site reports no crawler finding", () => {
    const out = slim(readiness("User-agent: *\nAllow: /\n"));
    expect(out.robots_read).toBe(true);
    expect(stateOf(out, "OAI-SearchBot")?.state).toBe("allowed");
    expect(out.findings.filter((f) => f.code.startsWith("ai_crawler"))).toEqual([]);
  });

  it("an unreadable robots.txt is unknown for every crawler, never allowed", () => {
    const out = slim(readiness(null, false));
    expect(out.robots_read).toBe(false);
    expect(out.crawlers.every((c) => c.state === "unknown")).toBe(true);
  });

  it("carries the markup facts per fetched page and no readiness score", () => {
    const out = slim(readiness("User-agent: *\nAllow: /\n"));
    expect(out.pages.map((p) => p.url)).toEqual(["https://example.com/", "https://example.com/pricing"]);
    expect(out.pages[0]).toMatchObject({ server_rendered: true, schema_types: ["Organization"] });
    expect(JSON.stringify(out)).not.toContain('"score"');
    expect(JSON.stringify(out).length).toBeLessThan(12000);
  });

  it("says nothing was checked when the audit could not be read or run", () => {
    expect(slimReadiness(null)).toMatchObject({ checked: false, status: "error", error_code: "geo_readiness_unavailable" });
  });

  it("never serves a day-old crawl: reads only a snapshot under a minute old", async () => {
    getGeoReadiness.mockResolvedValue(readiness("User-agent: *\nAllow: /\n"));
    await geoReadinessTool.execute({ tenant_id: CTX_TENANT, log: () => {} } as unknown as Parameters<typeof geoReadinessTool.execute>[0], {});
    expect(getGeoReadiness.mock.calls[0][1]).toMatchObject({ maxAgeMs: 60_000 });
  });

  it("stores nothing on a writes-suppressed run", async () => {
    getGeoReadiness.mockResolvedValue(readiness("User-agent: *\nAllow: /\n"));
    const ctx = { tenant_id: CTX_TENANT, log: () => {}, writes_suppressed: true } as unknown as Parameters<typeof geoReadinessTool.execute>[0];
    await geoReadinessTool.execute(ctx, {});
    expect(getGeoReadiness).toHaveBeenLastCalledWith(CTX_TENANT, expect.objectContaining({ persist: false }));
    await geoReadinessTool.execute({ ...ctx, writes_suppressed: undefined }, {});
    expect(getGeoReadiness).toHaveBeenLastCalledWith(CTX_TENANT, expect.objectContaining({ persist: true }));
  });
});
