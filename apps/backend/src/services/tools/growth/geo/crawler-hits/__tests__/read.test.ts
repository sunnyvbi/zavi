import { describe, it, expect } from "vitest";
import { summarizeCrawlerHits } from "../read";
import { changedVerdicts } from "../robots-history";
import { AI_CRAWLERS, type CrawlerAccess } from "../../analyze";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const connected = { connected: true, token_prefix: "zgeo_abc123", created_at: "2026-09-01T00:00:00Z", last_received_at: "2026-09-17T11:00:00Z" };

const row = (bot: string, day: string, hits: number, status = 200, path = "/") => ({
  day,
  bot,
  path,
  status,
  hits,
  first_seen_at: `${day}T06:00:00.000Z`,
  last_seen_at: `${day}T18:00:00.000Z`,
});

describe("summarizeCrawlerHits", () => {
  it("lists every citation-class bot even at zero, citation class first", () => {
    const p = summarizeCrawlerHits({ rows: [row("GPTBot", "2026-09-15", 900)], robots: new Map(), ingest: connected, windowDays: 7, now: NOW });
    expect(p.tier).toBe(3);
    expect(p.provenance).toBe("server_logs");
    const names = p.bots.map((b) => b.bot);
    for (const b of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Bingbot"]) expect(names).toContain(b);
    expect(p.bots.slice(0, 4).every((b) => b.recommended)).toBe(true);
    expect(names).not.toContain("Google-Extended");
  });

  it("totals hits, blocked hits and class split, with a zero-filled daily series", () => {
    const p = summarizeCrawlerHits({
      rows: [
        row("OAI-SearchBot", "2026-09-16", 10),
        row("OAI-SearchBot", "2026-09-16", 4, 403),
        row("ClaudeBot", "2026-09-17", 6, 200, "/pricing"),
      ],
      robots: new Map(),
      ingest: connected,
      windowDays: 7,
      now: NOW,
    });
    expect(p.totals).toEqual({ hits: 20, blocked_hits: 4, by_class: { training: 6, search: 14, user: 0 } });
    expect(p.daily).toHaveLength(7);
    expect(p.daily.find((d) => d.day === "2026-09-16")).toMatchObject({ hits: 14, blocked_hits: 4 });
    expect(p.daily.find((d) => d.day === "2026-09-12")).toMatchObject({ hits: 0 });
    const oai = p.bots.find((b) => b.bot === "OAI-SearchBot")!;
    expect(oai).toMatchObject({ hits: 14, blocked_hits: 4, pages: 1 });
    expect(p.top_pages[0]).toMatchObject({ path: "/", hits: 14, bots: 1 });
  });

  it("says '0 hits since we saw robots.txt change' — the confirmation the panel exists for", () => {
    const robots = new Map([
      [
        "Claude-SearchBot",
        {
          current: { state: "allowed", directive: null, observed_at: "2026-09-11T00:00:00Z" },
          previous: { state: "blocked" },
        },
      ],
    ]);
    const p = summarizeCrawlerHits({
      rows: [row("Claude-SearchBot", "2026-09-05", 3)],
      robots,
      ingest: connected,
      windowDays: 30,
      now: NOW,
    });
    const c = p.bots.find((b) => b.bot === "Claude-SearchBot")!;
    expect(c.robots).toMatchObject({ state: "allowed", previous_state: "blocked", changed_at: "2026-09-11T00:00:00Z" });
    expect(c.hits_since_robots_change).toBe(0);
    expect(c.callout).toMatch(/0 hits since we saw robots\.txt change 6 days ago/);
  });

  it("names a CDN/WAF block when every request was turned away", () => {
    const p = summarizeCrawlerHits({ rows: [row("PerplexityBot", "2026-09-16", 12, 403)], robots: new Map(), ingest: connected, windowDays: 7, now: NOW });
    expect(p.bots.find((b) => b.bot === "PerplexityBot")!.callout).toMatch(/CDN, firewall or auth rule/);
  });

  it("distinguishes not connected from connected-but-silent", () => {
    const off = summarizeCrawlerHits({ rows: [], robots: new Map(), ingest: { connected: false, token_prefix: null, created_at: null, last_received_at: null }, windowDays: 7, now: NOW });
    expect(off.state).toBe("not_connected");
    expect(off.bots.every((b) => b.callout === null)).toBe(true);
    const waiting = summarizeCrawlerHits({ rows: [], robots: new Map(), ingest: { ...connected, last_received_at: null }, windowDays: 7, now: NOW });
    expect(waiting.state).toBe("awaiting_logs");
  });
});

describe("changedVerdicts", () => {
  const access = (name: string, state: CrawlerAccess["state"]): CrawlerAccess => ({
    ...AI_CRAWLERS.find((c) => c.name === name)!,
    state,
    directive: state === "blocked" ? "Disallow: /" : null,
    from_wildcard: false,
  });

  it("records only verdicts that differ from the last one, and never 'unknown'", () => {
    const latest = new Map([
      ["OAI-SearchBot", "allowed"],
      ["Claude-SearchBot", "blocked"],
    ]);
    const changed = changedVerdicts(
      [access("OAI-SearchBot", "allowed"), access("Claude-SearchBot", "allowed"), access("PerplexityBot", "blocked"), access("Bingbot", "unknown")],
      latest,
    );
    expect(changed).toEqual([
      { bot: "Claude-SearchBot", state: "allowed", directive: null },
      { bot: "PerplexityBot", state: "blocked", directive: "Disallow: /" },
    ]);
  });
});
