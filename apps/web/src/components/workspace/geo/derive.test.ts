import { describe, it, expect } from "vitest";
import {
  checklistOf,
  crawlerSeries,
  deltaView,
  progressRowsOf,
  siteFilesOf,
  sourceGroupsOf,
} from "./derive";
import type {
  CrawlerDay,
  CrawlerHitsPanel,
  ReadinessLane,
  VisibilityHistoryRow,
  VisibilityMetrics,
} from "./types";

describe("deltaView — the interface refuses to dramatise noise", () => {
  it("gives a move outside the 95% band its arrow", () => {
    expect(deltaView({ delta_pp: 6.2, significant: true })).toMatchObject({
      text: "▲ 6.2 pts",
      tone: "up",
    });
    expect(deltaView({ delta_pp: -3, significant: true })).toMatchObject({
      text: "▼ 3 pts",
      tone: "down",
    });
  });

  it("strips the arrow from a move inside the band and says why", () => {
    const v = deltaView({ delta_pp: 1.4, significant: false });
    expect(v?.tone).toBe("flat");
    expect(v?.text).not.toContain("▲");
    expect(v?.title).toMatch(/noise/i);
  });

  it("names a changed baseline instead of drawing a number", () => {
    expect(deltaView({ unavailable: "prompt_set_changed" })).toMatchObject({
      text: "New prompts",
      tone: "note",
    });
    expect(deltaView({ unavailable: "rival_set_changed" })?.text).toBe("New rivals");
  });

  it("says nothing at all when there is no window to compare with", () => {
    expect(deltaView({ unavailable: "no_previous_window" })).toBeNull();
    expect(deltaView(null)).toBeNull();
  });
});

const day = (i: number): string =>
  new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10);

function panel(
  hits: number[],
  ingestCreatedAt: string | null,
  over: Partial<CrawlerHitsPanel> = {},
): CrawlerHitsPanel {
  const daily: CrawlerDay[] = hits.map((h, i) => ({
    day: day(i),
    hits: h,
    blocked_hits: 0,
    by_class: { search: h, user: 0, training: 0 },
  }));
  return {
    disclosure: "",
    state: "ok",
    window_days: hits.length,
    ingest: { connected: true, created_at: ingestCreatedAt, last_received_at: day(hits.length - 1) },
    totals: { hits: hits.reduce((a, b) => a + b, 0), blocked_hits: 0 },
    bots: [],
    daily,
    ...over,
  };
}

describe("crawlerSeries", () => {
  it("shows the selected window and compares it with the one before", () => {
    const hits = [...Array(16).fill(5), ...Array(7).fill(10), ...Array(7).fill(5)];
    const s = crawlerSeries(panel(hits, day(0)), 7)!;
    expect(s.days).toHaveLength(7);
    expect(s.total).toBe(35);
    expect(s.change).toEqual({ kind: "pct", pct: -50 });
  });

  it("refuses a percentage when the previous window predates the logs", () => {
    const hits = [...Array(23).fill(0), ...Array(7).fill(9)];
    const s = crawlerSeries(panel(hits, day(23)), 7)!;
    expect(s.total).toBe(63);
    expect(s.change).toBeNull();
  });

  it("calls a genuinely empty previous window new, not infinite growth", () => {
    const hits = [...Array(23).fill(0), ...Array(7).fill(9)];
    const s = crawlerSeries(panel(hits, day(0)), 7)!;
    expect(s.change).toEqual({ kind: "new" });
  });

  it("returns nothing rather than a short window", () => {
    expect(crawlerSeries(panel(Array(6).fill(1), day(0)), 7)).toBeNull();
  });
});

function readiness(over: Partial<ReadinessLane> = {}): ReadinessLane {
  return {
    status: "ok",
    site: "https://example.com",
    fetched_at: "2026-09-17T00:00:00.000Z",
    pages_analyzed: 3,
    score: { total: 62, bands: [] },
    completeness: { below_floor: false, warning: null },
    disclosure: "",
    crawlers: [{ name: "OAI-SearchBot", recommended: true, state: "allowed" }],
    llms_txt: true,
    findings: [],
    not_checked: [],
    grade: "medium",
    ...over,
  };
}

describe("checklistOf — not checked is never a pass", () => {
  it("passes a rule the crawl could have raised and did not", () => {
    const rows = checklistOf(readiness());
    expect(rows.find((r) => r.key === "schema")?.status).toBe("pass");
    expect(rows.find((r) => r.key === "crawlers")?.status).toBe("pass");
  });

  it("fails a rule with the finding's own sentence attached", () => {
    const rows = checklistOf(
      readiness({
        findings: [
          {
            code: "no_lead_passage",
            severity: "high",
            summary: "2 page(s) have no self-contained passage.",
            urls: [],
          },
        ],
      }),
    );
    const row = rows.find((r) => r.key === "lead_passage")!;
    expect(row.status).toBe("fix");
    expect(row.detail).toMatch(/self-contained/);
  });

  it("marks every page rule not checked when no page came back", () => {
    const rows = checklistOf(readiness({ pages_analyzed: 0 }));
    expect(rows.filter((r) => r.status === "not_checked")).toHaveLength(8);
    expect(rows.find((r) => r.key === "crawlers")?.status).toBe("pass");
  });

  it("marks crawler access not checked when robots.txt could not be read", () => {
    const rows = checklistOf(
      readiness({ crawlers: [{ name: "OAI-SearchBot", recommended: true, state: "unknown" }] }),
    );
    expect(rows.find((r) => r.key === "crawlers")?.status).toBe("not_checked");
  });

  it("fails crawler access when a path rule walls public pages off from a search bot", () => {
    const rows = checklistOf(
      readiness({
        crawlers: [{ name: "OAI-SearchBot", recommended: true, state: "partial" }],
        findings: [
          {
            code: "ai_crawler_partly_blocked",
            severity: "medium",
            summary: "robots.txt keeps OAI-SearchBot out of /blog (a rule for every bot).",
            urls: ["/robots.txt"],
          },
        ],
      }),
    );
    const row = rows.find((r) => r.key === "crawlers")!;
    expect(row.status).toBe("fix");
    expect(row.detail).toMatch(/out of \/blog/);
  });

  it("checks nothing at all without a readiness read", () => {
    expect(checklistOf(null).every((r) => r.status === "not_checked")).toBe(true);
  });
});

describe("siteFilesOf", () => {
  it("separates 'could not read robots.txt' from 'llms.txt is missing'", () => {
    const rows = siteFilesOf(
      readiness({
        crawlers: [{ name: "OAI-SearchBot", recommended: true, state: "unknown" }],
        llms_txt: false,
      }),
    );
    expect(rows).toEqual([
      { name: "robots.txt", status: "unreadable" },
      { name: "llms.txt", status: "missing" },
    ]);
  });

  it("reports both found on a clean read", () => {
    expect(siteFilesOf(readiness()).every((r) => r.status === "found")).toBe(true);
  });

  it("says not checked when llms.txt was never looked at", () => {
    const rows = siteFilesOf(readiness({ llms_txt: null }));
    expect(rows.find((r) => r.name === "llms.txt")?.status).toBe("not_checked");
  });
});

describe("sourceGroupsOf", () => {
  it("splits citations by who owns the source and flags a truncated list", () => {
    const m = {
      source_mix: {
        domains: [
          { domain: "example.com", responses: 8, used: 0.4, citations: 10, kind: "owned", rival: null },
          { domain: "usecarly.com", responses: 3, used: 0.15, citations: 6, kind: "rival", rival: "Carly" },
          { domain: "reddit.com", responses: 2, used: 0.1, citations: 4, kind: "other", rival: null },
        ],
        domains_total: 31,
      },
    } as unknown as VisibilityMetrics;
    const { groups, total, partial } = sourceGroupsOf(m);
    expect(total).toBe(20);
    expect(partial).toBe(true);
    expect(groups.map((g) => g.share)).toEqual([50, 30, 20]);
  });
});

const sweep = (over: Partial<VisibilityHistoryRow>): VisibilityHistoryRow => ({
  sweep_id: Math.random().toString(),
  finished_at: "2026-09-10T00:00:00.000Z",
  mention_rate: 0.5,
  citation_rate: 0.3,
  share_of_voice: 0.2,
  rival_set_changed: false,
  prompt_set_changed: false,
  ...over,
});

describe("progressRowsOf", () => {
  it("measures from the first to the latest comparable sweep", () => {
    const rows = progressRowsOf([
      sweep({ mention_rate: 0.4 }),
      sweep({ mention_rate: 0.46 }),
      sweep({ mention_rate: 0.54 }),
    ]);
    const mention = rows.find((r) => r.key === "mention_rate")!;
    expect(mention.points).toEqual([40, 46, 54]);
    expect(mention.change).toBe(14);
    expect(mention.trimmed).toBe(false);
  });

  it("starts a new line where the prompt set changed", () => {
    const rows = progressRowsOf([
      sweep({ mention_rate: 0.9 }),
      sweep({ mention_rate: 0.3, prompt_set_changed: true }),
      sweep({ mention_rate: 0.35 }),
    ]);
    const mention = rows.find((r) => r.key === "mention_rate")!;
    expect(mention.points).toEqual([30, 35]);
    expect(mention.trimmed).toBe(true);
  });

  it("holds share of voice to one rival list", () => {
    const rows = progressRowsOf([
      sweep({ share_of_voice: 0.6 }),
      sweep({ share_of_voice: 0.2, rival_set_changed: true }),
    ]);
    const sov = rows.find((r) => r.key === "share_of_voice")!;
    expect(sov.points).toEqual([20]);
    expect(sov.change).toBeNull();
  });
});
