
import { describe, expect, it } from "vitest";
import { dayLabel } from "./derive";
import { geoChrome, geoKpis, geoTables, hitsTable } from "./extraTables";
import type { DeltaOr, GeoChannelPayload } from "./types";
import { emptyTiles } from "../actions/channelEmptyTiles";
import { geo } from "../actions/platforms/geo";

function payload(mention: DeltaOr, citation: DeltaOr): GeoChannelPayload {
  const rate = (r: number) => ({
    numerator: Math.round(r * 100),
    denominator: 100,
    rate: r,
    ci95: { low: r - 0.05, high: r + 0.05 },
    margin_pp: 5,
    by_engine: [],
  });
  return {
    readiness: { error: true },
    crawler_hits: { error: true },
    visibility: {
      state: "ok",
      country: "US",
      window_days: 30,
      metrics: {
        disclosure: "A sample of AI answers.",
        responses: { planned: 100, collected: 100, failed: 0, sweeps: 2, prompts: 5, engines: 2 },
        mention_rate: rate(0.42),
        citation_rate: rate(0.18),
        source_mix: { domains: [], domains_total: 0 },
        share_of_voice: { state: "no_rivals", share: null, brand_mentions: 0, rival_mentions: 0, rivals: [] },
      },
      deltas: { mention_rate: mention, citation_rate: citation, share_of_voice: { unavailable: "no_previous_window" } },
      running: null,
      history: [],
      config: {
        enabled: true,
        configured: true,
        brand: "Example",
        prompts_active: 5,
        suggestions_pending: 0,
        engines: [],
        countries: [],
      },
    },
  } as unknown as GeoChannelPayload;
}

const kpi = (p: GeoChannelPayload, key: string) => geoKpis(p).find((m) => m.key === key);

describe("a sampled rate's change is the payload's number, not the chip's text", () => {
  it("carries a SIGNIFICANT drop as a previous value above the current one", () => {
    const p = payload({ delta_pp: -3, significant: true }, { delta_pp: 2, significant: true });
    const mention = kpi(p, "geo_mention_rate")!;
    expect(mention.value).toBe(42);
    expect(mention.prev_value).toBe(45);
    const citation = kpi(p, "geo_citation_rate")!;
    expect(citation.value).toBe(18);
    expect(citation.prev_value).toBe(16);
  });

  it("carries NO change for an insignificant move, in either direction", () => {
    const p = payload({ delta_pp: -1.4, significant: false }, { delta_pp: 0.8, significant: false });
    expect(kpi(p, "geo_mention_rate")!.prev_value).toBeNull();
    expect(kpi(p, "geo_citation_rate")!.prev_value).toBeNull();
  });

  it("carries no change when the payload says there is nothing to compare", () => {
    const p = payload({ unavailable: "prompt_set_changed" }, { unavailable: "no_previous_window" });
    expect(kpi(p, "geo_mention_rate")!.prev_value).toBeNull();
    expect(kpi(p, "geo_citation_rate")!.prev_value).toBeNull();
  });
});

describe("a lane that failed is not a lane with nothing in it", () => {
  it("draws no readiness or hits table, and no card for them, when those lanes errored", () => {
    const p = payload({ delta_pp: 0, significant: false }, { delta_pp: 0, significant: false });
    const ids = geoTables(p).map((t) => t.id);
    expect(ids).not.toContain("geo_bands");
    expect(ids).not.toContain("geo_hits");
    expect(kpi(p, "geo_score")).toBeUndefined();
    expect(kpi(p, "geo_hits")).toBeUndefined();
    expect(ids).toContain("geo_sources");
  });
});

import { PLATFORMS } from "../actions/platforms";

describe("the Mentioned number heads a mentions table, not the cited one", () => {
  function withSov(sov: Record<string, unknown>) {
    const p = payload({ delta_pp: 0, significant: false }, { delta_pp: 0, significant: false });
    const m = (p.visibility as unknown as { metrics: { share_of_voice: unknown } }).metrics;
    m.share_of_voice = sov;
    return p;
  }

  it("the Mentioned card selects geo_mentions and Cited selects geo_sources", () => {
    expect(PLATFORMS.geo.metricDisplay?.geo_mention_rate?.selects).toBe("geo_mentions");
    expect(PLATFORMS.geo.metricDisplay?.geo_citation_rate?.selects).toBe("geo_sources");
  });

  it("draws the brand first, then rivals by mention, with share of voice", () => {
    const p = withSov({
      state: "ok",
      share: 0.3,
      brand_mentions: 30,
      rival_mentions: 70,
      rivals: [{ name: "Revv", mentions: 70, share: 0.7 }],
    });
    const t = geoTables(p).find((x) => x.id === "geo_mentions")!;
    expect(t.title).toBe("Who the answers named");
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].cells[0].text).toBe("Example");
    expect(t.rows[0].cells[2].text).toBe("30");
    expect(t.rows[1].cells[0].text).toBe("Revv");
    expect(t.rows[1].cells[2].text).toBe("70");
  });

  it("prints a small share to one decimal, as the headline rate does", () => {
    const p = withSov({
      state: "ok",
      share: 0.0057,
      brand_mentions: 1,
      rival_mentions: 174,
      rivals: [{ name: "Turo", mentions: 174, share: 0.9943 }, { name: "Zevo", mentions: 0, share: 0 }],
    });
    const t = geoTables(p).find((x) => x.id === "geo_mentions")!;
    expect(t.rows.map((r) => r.cells[3].text)).toEqual(["0.6%", "99%", "0%"]);
  });

  it("still shows the brand row when no rivals are set, with an em dash share", () => {
    const p = withSov({ state: "no_rivals", share: null, brand_mentions: 12, rival_mentions: 0, rivals: [] });
    const t = geoTables(p).find((x) => x.id === "geo_mentions")!;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].cells[2].text).toBe("12");
    expect(t.rows[0].cells[3].text).toBe("-");
  });

  it("draws no rows, only an empty sentence, when nothing was named", () => {
    const p = withSov({ state: "no_mentions", share: null, brand_mentions: 0, rival_mentions: 0, rivals: [] });
    const t = geoTables(p).find((x) => x.id === "geo_mentions")!;
    expect(t.rows).toHaveLength(0);
    expect(t.empty).toContain("named your brand or a rival");
  });
});

function withConfig(config: Partial<GeoChannelPayload["visibility"] extends infer V ? V extends { config: infer C } ? C : never : never>) {
  const p = payload({ delta_pp: 0, significant: false }, { delta_pp: 0, significant: false });
  const v = p.visibility as unknown as { config: Record<string, unknown> };
  v.config = { ...v.config, ...config };
  return p;
}

describe("the scan control says nothing rather than something false", () => {
  const fresh = PLATFORMS.geo.scan!.freshnessOf;

  it("draws NO control when there are no prompts — it is not 'turned off'", () => {
    expect(fresh(withConfig({ prompts_active: 0 }))).toBeNull();
  });

  it("draws NO control when Zavi's own sampler is not configured", () => {
    expect(fresh(withConfig({ configured: false }))).toBeNull();
  });

  it("draws NO control when the company name is missing", () => {
    expect(fresh(withConfig({ brand: null }))).toBeNull();
  });

  it("says turned off ONLY when the tenant's switch is off", () => {
    expect(fresh(withConfig({ enabled: false }))?.enabled).toBe(false);
  });

  it("is a live control when the channel can actually sweep", () => {
    expect(fresh(withConfig({}))?.enabled).toBe(true);
  });

  it("keeps showing a RUNNING sweep even after the last prompt is removed", () => {
    const p = withConfig({ prompts_active: 0 });
    (p.visibility as unknown as { running: unknown }).running = {
      sweep_id: "s1", country: "US", started_at: new Date().toISOString(), planned: 10, collected: 3,
    };
    expect(fresh(p)?.running).toBe(true);
  });
});

describe("the starter-prompt seed spends only when it can buy something", () => {
  const empty = PLATFORMS.geo.payload!.seed!.emptyWhen;
  const blank = { prompts_active: 0, suggestions_pending: 0 };

  it("fires for a configured tenant with a company name and no prompts", () => {
    expect(empty(withConfig({ ...blank }))).toBe(true);
  });

  it("does not fire without Zavi's sampler, or without a company name", () => {
    expect(empty(withConfig({ ...blank, configured: false }))).toBe(false);
    expect(empty(withConfig({ ...blank, brand: null }))).toBe(false);
  });

  it("fires for an outgrown starter set, but not over drafts waiting for a person", () => {
    const outgrown = { prompts_active: 5, suggestions_pending: 0, starter_stale: true };
    expect(empty(withConfig(outgrown))).toBe(true);
    expect(empty(withConfig({ ...outgrown, suggestions_pending: 5 }))).toBe(false);
    expect(empty(withConfig({ prompts_active: 5, suggestions_pending: 0 }))).toBe(false);
  });
});

describe("an empty prompt list names the right reason", () => {
  const promptsTable = (p: GeoChannelPayload) =>
    geoTables({ ...p, prompts: { active: [], suggested: [] } }).find((t) => t.id === "geo_prompts")!;

  it("does not tell the founder to act when the missing piece is Zavi's", () => {
    const t = promptsTable(withConfig({ configured: false }));
    expect(t.empty).toMatch(/not set up on our side/);
    expect(t.empty).not.toMatch(/company name/);
  });

  it("asks for the company name only when that is what is missing", () => {
    expect(promptsTable(withConfig({ brand: null })).empty).toMatch(/company name/);
  });

  it("does not ask for anything when the visibility lane could not be read", () => {
    const p = withConfig({});
    (p as { visibility: unknown }).visibility = { error: true };
    const table = promptsTable(p);
    expect(table.empty).not.toMatch(/company name/);
    expect(table.empty).not.toMatch(/not set up on our side/);
    expect(table.empty).not.toMatch(/starter set|next read/);
  });
});

function withCrawlers(crawlers: unknown[]): GeoChannelPayload {
  return {
    readiness: {
      status: "ok",
      site: "https://example.com",
      fetched_at: "2026-09-17T00:00:00.000Z",
      pages_analyzed: 3,
      score: { total: 62, bands: [] },
      completeness: { below_floor: false, warning: null },
      disclosure: "",
      crawlers,
      llms_txt: true,
      findings: [],
      not_checked: [],
      grade: "medium",
    },
    visibility: { error: true },
    crawler_hits: { error: true },
  } as unknown as GeoChannelPayload;
}

describe("a crawler's verdict opens onto the rule that made it", () => {
  const crawlerRows = (p: GeoChannelPayload) => geoTables(p).find((t) => t.id === "geo_crawlers")!.rows;

  it("shows the line, whose rule it is, the blocked paths and who changes it", () => {
    const [row] = crawlerRows(
      withCrawlers([
        {
          name: "OAI-SearchBot",
          recommended: true,
          state: "partial",
          directive: "Disallow: /blog",
          from_wildcard: true,
          disallowed_paths: ["/blog", "/pricing"],
        },
      ]),
    );
    expect(row.detail?.openLabel).toBe("See the rule");
    const lines = row.detail!.text.split("\n");
    expect(lines).toEqual([
      "The line: Disallow: /blog",
      "A rule for every bot",
      "Blocked paths: /blog, /pricing",
      "To change it: whoever edits your site removes that Disallow line from /robots.txt. Private areas like /admin can stay blocked.",
    ]);
    expect(row.cells[1].text).toBe("Partly blocked");
  });

  it("names a rule written for this bot, and gives no how-to for an allowed bot", () => {
    const [row] = crawlerRows(
      withCrawlers([{ name: "PerplexityBot", recommended: true, state: "allowed", directive: "Allow: /", from_wildcard: false }]),
    );
    expect(row.detail!.text).toBe("The line: Allow: /\nA rule written for this bot");
  });

  it("opens nothing when the crawl read no line for the bot", () => {
    const [row] = crawlerRows(withCrawlers([{ name: "GPTBot", recommended: false, state: "allowed", directive: null }]));
    expect(row.detail).toBeUndefined();
  });
});

describe("every readiness check says who can change it", () => {
  it("draws a Who column: the words are yours, the markup and site files a developer's", () => {
    const t = geoTables(withCrawlers([{ name: "OAI-SearchBot", recommended: true, state: "allowed" }])).find(
      (x) => x.id === "geo_checks",
    )!;
    expect(t.columns.map((c) => c.label)).toEqual(["Check", "Result", "Who"]);
    const who = (id: string) => t.rows.find((r) => r.id === id)!.cells[2].text;
    for (const id of ["server_rendered", "schema", "crawlers", "file-llms.txt"]) expect(who(id)).toBe("Developer");
    for (const id of ["lead_passage", "question_headings", "figures", "author", "dates", "fresh"]) {
      expect(who(id)).toBe("You");
    }
    expect(t.rows.every((r) => r.cells.length === 3)).toBe(true);
  });
});

function withHits(state: "not_connected" | "awaiting_logs" | "ok", hits: number, last: string | null): GeoChannelPayload {
  const bot = {
    bot: "OAI-SearchBot",
    owner: "OpenAI",
    class: "search",
    recommended: true,
    hits,
    blocked_hits: 0,
    robots: { state: "allowed" },
    callout: null,
  };
  return {
    readiness: { error: true },
    visibility: { error: true },
    crawler_hits: {
      disclosure: "Counted from your own logs.",
      state,
      window_days: 30,
      ingest: { connected: state !== "not_connected", created_at: null, last_received_at: last },
      totals: { hits, blocked_hits: 0 },
      bots: [bot],
      daily: [],
    },
  } as unknown as GeoChannelPayload;
}

describe("the crawler-hits table says which zero it is", () => {
  const hits = (p: GeoChannelPayload) =>
    hitsTable((p as unknown as { crawler_hits: Parameters<typeof hitsTable>[0] }).crawler_hits);

  it("draws no zeros before any log arrived, and says the feed is connected but empty", () => {
    const t = hits(withHits("awaiting_logs", 0, null));
    expect(t.rows).toEqual([]);
    expect(t.empty).toBe("Your log feed is connected but no log has arrived yet.");
  });

  it("draws no zeros when logs are not connected at all", () => {
    const t = hits(withHits("not_connected", 0, null));
    expect(t.rows).toEqual([]);
    expect(t.empty).toMatch(/not receiving your logs/);
  });

  it("keeps real zeros and says when the last log came, so a stopped feed is visible", () => {
    const t = hits(withHits("ok", 0, "2026-09-20T08:00:00.000Z"));
    expect(t.rows).toHaveLength(1);
    expect(t.caption).toBe(
      `No AI crawler fetched a page in this window. Last log arrived ${dayLabel("2026-09-20")}; if that is over a day ago, the feed may have stopped. Counted from your own logs.`,
    );
  });

  it("says nothing extra when crawlers did come", () => {
    const t = hits(withHits("ok", 12, "2026-09-20T08:00:00.000Z"));
    expect(t.caption).toBe("Counted from your own logs.");
  });
});

describe("a rule over private areas only asks for no change", () => {
  const crawlerRows = (p: GeoChannelPayload) => geoTables(p).find((t) => t.id === "geo_crawlers")!.rows;

  it("tells no one to remove a Disallow that only covers /admin", () => {
    const [row] = crawlerRows(
      withCrawlers([
        {
          name: "OAI-SearchBot",
          recommended: true,
          state: "partial",
          directive: "Disallow: /admin",
          from_wildcard: true,
          disallowed_paths: ["/admin", "/cart"],
        },
      ]),
    );
    expect(row.detail!.text).not.toMatch(/removes that Disallow line/);
    expect(row.detail!.text.split("\n").at(-1)).toBe("No change needed: only private areas are blocked, which is right.");
  });

  it("still gives the removal step when one blocked path is public", () => {
    const [row] = crawlerRows(
      withCrawlers([
        { name: "OAI-SearchBot", recommended: true, state: "partial", directive: "Disallow: /blog", disallowed_paths: ["/admin", "/blog"] },
      ]),
    );
    expect(row.detail!.text).toMatch(/removes that Disallow line/);
  });
});

describe("the backend's sitemap verdict decides what is public", () => {
  const appAreas = {
    name: "OAI-SearchBot",
    recommended: true,
    state: "partial",
    directive: "Disallow: /booking/",
    from_wildcard: true,
    disallowed_paths: ["/additional_driver/", "/booking/", "/bookings/", "/calendar/", "/change-password/"],
    public_blocked: [],
  };
  const crawlersTile = (p: GeoChannelPayload) => geoKpis(p).find((m) => m.key === "geo_crawlers")!.value;

  it("reads a bot kept out of app areas only as allowed, in the row, the rule and the tile", () => {
    const p = withCrawlers([appAreas]);
    const [row] = geoTables(p).find((t) => t.id === "geo_crawlers")!.rows;
    expect(row.cells[1]).toMatchObject({ text: "Allowed", chip: "good" });
    expect(row.detail!.text.split("\n").at(-1)).toBe("No change needed: only private areas are blocked, which is right.");
    expect(crawlersTile(p)).toBe(1);
  });

  it("still warns, names the page and gives the removal step when a listed page is closed", () => {
    const p = withCrawlers([{ ...appAreas, directive: "Disallow: /blog", disallowed_paths: ["/blog"], public_blocked: ["/blog/launch-notes"] }]);
    const [row] = geoTables(p).find((t) => t.id === "geo_crawlers")!.rows;
    expect(row.cells[1]).toMatchObject({ text: "Partly blocked", chip: "warn" });
    expect(row.detail!.text).toContain("Public pages it keeps out: /blog/launch-notes");
    expect(row.detail!.text).toMatch(/removes that Disallow line/);
    expect(crawlersTile(p)).toBe(0);
  });

  it("keeps the old name test for a row crawled before the verdict existed", () => {
    const { public_blocked: _unused, ...old } = appAreas;
    const [row] = geoTables(withCrawlers([old])).find((t) => t.id === "geo_crawlers")!.rows;
    expect(row.cells[1].text).toBe("Partly blocked");
  });
});

describe("counted hits are never hidden by the feed state", () => {
  const hits = (p: GeoChannelPayload) =>
    hitsTable((p as unknown as { crawler_hits: Parameters<typeof hitsTable>[0] }).crawler_hits);

  it("keeps the rows when the feed was disconnected after hits were counted", () => {
    const t = hits(withHits("not_connected", 7, "2026-09-20T08:00:00.000Z"));
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].cells[1].text).toBe("7");
    expect(t.caption).toMatch(/^Zavi is not receiving your logs now/);
  });

  it("keeps the rows for hits counted while awaiting a new log", () => {
    const t = hits(withHits("awaiting_logs", 3, null));
    expect(t.rows).toHaveLength(1);
  });
});

describe("the crawler-hits lane is hidden from the page", () => {
  it("draws no hits table even when the lane reports real counts", () => {
    const ids = geoTables(withHits("ok", 12, "2026-09-20T08:00:00.000Z")).map((t) => t.id);
    expect(ids).not.toContain("geo_hits");
  });

  it("prints no hits number either, so nothing heads a table that is not there", () => {
    const m = geoKpis(withHits("ok", 12, "2026-09-20T08:00:00.000Z"));
    expect(m.find((x) => x.key === "geo_hits")).toBeUndefined();
  });

  it("draws no blank hits tile before anything is measured", () => {
    expect(emptyTiles(geo).map((m) => m.key)).not.toContain("geo_hits");
  });
});

describe("a window with no sampled answers says why its rates are gone", () => {
  it("names the window instead of dropping Mentioned and Cited silently", () => {
    const p = payload({ delta_pp: 0, significant: false }, { delta_pp: 0, significant: false });
    const v = p.visibility as unknown as { state: string; window_days: number; metrics: unknown };
    v.state = "no_data_in_window";
    v.window_days = 7;
    v.metrics = null;
    expect(geoKpis(p).some((m) => m.key === "geo_mention_rate")).toBe(false);
    expect(geoChrome(p)?.problem?.text).toContain("No AI answers were checked in the last 7 days");
  });

  it("says nothing when the window has answers", () => {
    const p = payload({ delta_pp: 0, significant: false }, { delta_pp: 0, significant: false });
    expect(geoChrome(p)?.problem?.text ?? "").not.toContain("No AI answers were checked");
  });
});
