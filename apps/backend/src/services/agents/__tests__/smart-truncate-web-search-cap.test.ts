
import { describe, it, expect } from "vitest";
import { smartTruncateToolResult, toolResultCapBytes } from "../smart-truncate";

function searchResult(n: number, snippetBytes: number): string {
  return JSON.stringify({
    query: "water heater replacement San Jose plumber",
    answer:
      "Several plumbing companies in San Jose offer water heater replacement, including same-day service and permit handling for tank and tankless units.",
    results: Array.from({ length: n }, (_, i) => ({
      title: `Water Heater Replacement in San Jose, CA | Provider ${i + 1}`,
      url: `https://provider-${i + 1}.example.com/san-jose-ca/water-heater-replacement/`,
      content: "x".repeat(snippetBytes),
      score: 0.8 - i * 0.05,
    })),
  });
}

describe("web_search cap — a whole typical result set reaches the model", () => {
  it("gives web_search:search its own budget (6KB in #2689, 48KB after the 09-17 measurement)", () => {
    expect(toolResultCapBytes("web_search", "search")).toBe(48 * 1024);
  });

  it("github__read_file rides the default (raised 2KB -> 16KB on 09-17; it was capped on 149 of 161 prod calls)", () => {
    expect(toolResultCapBytes("github", "read_file")).toBe(16 * 1024);
  });

  it("keeps all 7 results of a typical search (snippets ~500 B)", () => {
    const raw = searchResult(7, 500);
    const out = smartTruncateToolResult(raw, toolResultCapBytes("web_search", "search"));
    const parsed = JSON.parse(out);
    expect(parsed.results).toHaveLength(7);
    expect(parsed._truncated).toBeUndefined();
  });

  it("the 2KB default is what dropped them (regression anchor)", () => {
    const raw = searchResult(7, 500);
    const parsed = JSON.parse(smartTruncateToolResult(raw, 2 * 1024));
    expect(parsed._truncated).toBe(true);
    expect(parsed._returned).toBeLessThanOrEqual(2);
  });

  it("still degrades to a truncated envelope with a real _total when a search is huge", () => {
    const raw = searchResult(120, 1200);
    const parsed = JSON.parse(smartTruncateToolResult(raw, toolResultCapBytes("web_search", "search")));
    expect(parsed._truncated).toBe(true);
    expect(parsed._total).toBe(120);
    expect(parsed._returned).toBeGreaterThanOrEqual(3);
  });
});

describe("tool-result caps hold a whole typical payload", () => {
  it("default is 16KB, not the old 2KB", () => {
    expect(toolResultCapBytes("slack", "get_channel_history")).toBe(16 * 1024);
    expect(toolResultCapBytes("growth", "read_experiment_ledger")).toBe(16 * 1024);
  });

  it("raises the reads that were measured cutting load-bearing rows", () => {
    expect(toolResultCapBytes("meta_ads", "pixel_health")).toBe(24 * 1024);
    expect(toolResultCapBytes("meta_ads", "list_ad_sets")).toBe(24 * 1024);
    expect(toolResultCapBytes("meta_ads", "analyst_brief")).toBe(32 * 1024);
    expect(toolResultCapBytes("web_search", "search")).toBe(48 * 1024);
    expect(toolResultCapBytes("web_fetch", "fetch")).toBe(32 * 1024);
    expect(toolResultCapBytes("operator_db", "catalog")).toBe(32 * 1024);
    expect(toolResultCapBytes("reddit", "thread_read")).toBe(24 * 1024);
  });

  it("no tool can exceed the 128KB backstop", () => {
    for (const [s, t] of [
      ["praxis_corpus", "read_run_output"], ["web_search", "search"], ["operator_db", "catalog"],
      ["meta_ads", "analyst_brief"], ["growth", "seo_audit"], ["apify", "scrape_tiktok"],
    ] as const) {
      expect(toolResultCapBytes(s, t)).toBeLessThanOrEqual(128 * 1024);
    }
  });

  it("a 3-pixel health read now survives whole (the 0-of-9 case)", () => {
    const pixel = (i: number) => ({
      pixel_id: `139071544547279${i}`, overall_status: "degraded",
      event_coverage: { PageView: 12045, ViewContent: 3021, Purchase: 0, Lead: 44 },
      match_keys: ["em", "ph", "external_id", "client_ip_address", "client_user_agent"],
      limitation: "x".repeat(590), last_fired_at: "2026-09-17T04:02:00Z",
    });
    const raw = JSON.stringify({ pixels: [pixel(1), pixel(2), pixel(3)] });
    const parsed = JSON.parse(smartTruncateToolResult(raw, toolResultCapBytes("meta_ads", "pixel_health")));
    expect(parsed.pixels).toHaveLength(3);
    expect(parsed._truncated).toBeUndefined();
  });

  it("still truncates a pathological payload rather than blowing the turn", () => {
    const raw = JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => ({ id: i, body: "y".repeat(400) })) });
    const parsed = JSON.parse(smartTruncateToolResult(raw, toolResultCapBytes("web_fetch", "fetch")));
    expect(parsed._truncated).toBe(true);
    expect(parsed._total).toBe(4000);
  });
});
