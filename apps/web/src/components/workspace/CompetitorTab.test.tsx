import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompetitorTabView } from "./CompetitorTab";
import {
  competitiveRows,
  execSummaryProse,
  execSummaryBlock,
  reportSources,
  brandCount,
  type CompetitorIntelPayload,
  type CompetitorSnapshot,
} from "./useCompetitorIntel";
import { summaryLines } from "./competitorSummary";

const noop = () => {};

function snapshot(over: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot {
  return {
    week_bucket: "2026-06-08",
    created_at: "2026-06-08T09:05:00Z",
    delta: null,
    landscape: {
      kind: "report",
      template: "landscape",
      title: "Acme competitor landscape",
      blocks: [
        {
          type: "competitive_table",
          rows: [
            { brand: "Turo", positioning: "Scale leader", gap: "High fees" },
            { brand: "Getaround", positioning: "Instant unlock", gap: "Coverage" },
          ],
        },
      ],
      sources: [],
    },
    ...over,
  };
}

describe("CompetitorTabView — flag off", () => {
  it("renders the 'Not enabled' guard when enabled=false", () => {
    const data: CompetitorIntelPayload = { enabled: false, snapshots: [] };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("Not enabled");
    expect(html).not.toContain("Landscape");
  });
});

describe("CompetitorTabView — first-run empty", () => {
  it("renders the idle first-scan copy (no button) when onStartFirstScan is omitted", () => {
    const data: CompetitorIntelPayload = { enabled: true, snapshots: [] };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("No competitor scan yet");
    expect(html).toContain("weekly scan runs Monday automatically");
    expect(html).not.toContain("Run first scan now");
  });

  it("renders the 'Run first scan now' button when onStartFirstScan is provided", () => {
    const data: CompetitorIntelPayload = { enabled: true, snapshots: [] };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onStartFirstScan={async () => ({ status: "started" as const })}
      />,
    );
    expect(html).toContain("Run first scan now");
    expect(html).toContain("Or wait: the weekly scan runs Monday automatically");
  });

  it("renders the 'scanning' state (no button) when scan_in_progress is true", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [],
      scan_in_progress: true,
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onStartFirstScan={async () => ({ status: "already_running" as const })}
      />,
    );
    expect(html).toContain("Running your first scan now");
    expect(html).not.toContain("Run first scan now");
  });
});

describe("CompetitorTabView — populated with delta", () => {
  it("renders the competitive table rows + added/removed brand chips", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          delta: {
            added_brands: ["Kyte"],
            removed_brands: ["Zipcar"],
            narrative_md: null,
          },
        }),
        snapshot({ week_bucket: "2026-06-01" }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("Turo");
    expect(html).toContain("Scale leader");
    expect(html).toContain("Getaround");
    expect(html).toContain("Kyte");
    expect(html).toContain("Zipcar");
    expect(html).toContain("What changed this week");
    expect(html).toContain("New to the set");
    expect(html).toContain("No longer listed");
    expect(html).toContain("Previous weeks");
  });

  it("shows only the 'New to the set' label when nothing was removed (no empty 'No longer listed' header)", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          delta: { added_brands: ["Kyte"], removed_brands: [], narrative_md: null },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("New to the set");
    expect(html).not.toContain("No longer listed");
  });

  it("the summary/delta grid uses items-start so the shorter card doesn't stretch", () => {
    const data: CompetitorIntelPayload = { enabled: true, snapshots: [snapshot()] };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("items-start");
  });
});

describe("CompetitorTabView — recommended moves (2026-06-10 value pass)", () => {
  const recBlocks = [
    {
      type: "recommendations",
      items: [
        {
          index: 1,
          label: "move",
          title: "Undercut Turo's protection-fee anxiety",
          body_md: "Turo raised host fees; your gap is fee transparency. First step: publish a fee-comparison page this week.",
          citations: [],
        },
      ],
    },
    {
      type: "competitive_table",
      rows: [{ brand: "Turo", positioning: "Scale leader", gap: "High fees" }],
    },
  ];
  it("renders the Recommended moves module + Ask PM / Ask Growth lead CTAs when items exist", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          landscape: {
            kind: "report",
            template: "landscape",
            title: "Acme",
            blocks: recBlocks,
            sources: [],
          },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
      />,
    );
    expect(html).toContain("Recommended moves");
    expect(html).toContain("Undercut Turo");
    expect(html).toContain("Ask PM");
    expect(html).toContain("Ask Growth lead");
  });
  it("hides the module entirely when the recommendations block is absent or empty (older snapshots)", () => {
    const data: CompetitorIntelPayload = { enabled: true, snapshots: [snapshot()] };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
      />,
    );
    expect(html).not.toContain("Recommended moves");
  });
});

describe("CompetitorTabView — structured summary (Ravi feedback 2026-06-15)", () => {
  const summaryLandscape = {
    kind: "report",
    template: "landscape",
    title: "Acme",
    blocks: [
      {
        type: "exec_summary",
        prose_md:
          "Turo charges high fees [1]. Getaround unlocks instantly [2]. My read: lead with fee transparency.",
        pull_quote: "Fee transparency is the wedge.",
        stat_tiles: [
          { value: "$4,995/mo", label: "Designjoy unlimited" },
          { value: "from $299", label: "99designs contest" },
        ],
        citations: [1, 2],
      },
      {
        type: "competitive_table",
        rows: [{ brand: "Turo", positioning: "Scale leader", gap: "High fees" }],
      },
    ],
    sources: [
      { n: 1, title: "Turo fee guide", url: "https://www.example.com/turo" },
      { n: 2, title: "Getaround unlock", url: "https://getaround.com/unlock" },
    ],
  };

  it("renders stat tiles (number↔entity), bulleted prose, and verification source links", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot({ landscape: summaryLandscape })],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("$4,995/mo");
    expect(html).toContain("Designjoy unlimited");
    expect(html).toContain("My read");
    expect(html).toContain("lead with fee transparency");
    expect(html).toContain("Sources");
    expect(html).toContain("https://www.example.com/turo");
    expect(html).toContain("Turo fee guide");
    expect(html).toContain("getaround.com/unlock");
  });

  it("renumbers a non-contiguous cited subset to sequential [1..k] while preserving links", () => {
    const landscape = {
      kind: "report",
      template: "landscape",
      title: "Acme",
      blocks: [
        {
          type: "exec_summary",
          prose_md: "Turo charges high fees [3]. Getaround unlocks instantly [8].",
          citations: [3, 8],
        },
      ],
      sources: [
        { n: 3, title: "Turo fee guide", url: "https://www.example.com/turo" },
        { n: 8, title: "Getaround unlock", url: "https://getaround.com/unlock" },
      ],
    };
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot({ landscape })],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("[1]");
    expect(html).toContain("[2]");
    expect(html).not.toContain("[3]");
    expect(html).not.toContain("[8]");
    expect(html).toContain("https://www.example.com/turo");
    expect(html).toContain("getaround.com/unlock");
  });

  it("renumbers in READING order, not by master index (prose [8]…[3] → [1]…[2])", () => {
    const landscape = {
      kind: "report",
      template: "landscape",
      title: "Acme",
      blocks: [
        {
          type: "exec_summary",
          prose_md: "Getaround unlocks instantly [8]. Turo charges high fees [3].",
          citations: [8, 3],
        },
      ],
      sources: [
        { n: 3, title: "Turo fee guide", url: "https://www.example.com/turo" },
        { n: 8, title: "Getaround unlock", url: "https://getaround.com/unlock" },
      ],
    };
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot({ landscape })],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html.indexOf("[1]")).toBeLessThan(html.indexOf("[2]"));
    expect(html.indexOf("getaround.com/unlock")).toBeLessThan(
      html.indexOf("https://www.example.com/turo"),
    );
  });
});

describe("useCompetitorIntel — structured summary extractors", () => {
  it("execSummaryBlock lifts prose + pull_quote + stat_tiles + citations", () => {
    const block = execSummaryBlock({
      kind: "report",
      blocks: [
        {
          type: "exec_summary",
          prose_md: "Body.",
          pull_quote: "Quote.",
          stat_tiles: [
            { value: "$20", label: "Looka" },
            { value: 99, label: "bad-tile (non-string value dropped)" },
          ],
          citations: [1, 2, "x", 0],
        },
      ],
    });
    expect(block?.prose_md).toBe("Body.");
    expect(block?.pull_quote).toBe("Quote.");
    expect(block?.stat_tiles).toEqual([{ value: "$20", label: "Looka" }]);
    expect(block?.citations).toEqual([1, 2]);
    expect(execSummaryBlock({ kind: "report", blocks: [] })).toBeNull();
  });

  it("reportSources keeps only http(s) sources with an integer n, sorted", () => {
    const out = reportSources({
      kind: "report",
      blocks: [],
      sources: [
        { n: 2, title: "Two", url: "https://b.com" },
        { n: 1, title: "One", url: "https://a.com" },
        { n: 3, title: "Bad scheme", url: "ftp://c.com" },
        { n: "x", title: "Bad n", url: "https://d.com" },
      ],
    });
    expect(out.map((s) => s.n)).toEqual([1, 2]);
    expect(out[0].url).toBe("https://a.com");
  });

  it("summaryLines splits sentences, flags the 'My read' lead, and linkifies resolvable [n]", () => {
    const sources = [{ n: 1, title: "T", url: "https://a.com" }];
    const lines = summaryLines(
      "Turo is pricey [1]. An unresolved cite [9] stays text. My read: ship it.",
      sources,
    );
    expect(lines.length).toBe(3);
    expect(lines[0].segments.some((s) => s.kind === "cite" && s.n === 1)).toBe(true);
    expect(lines[1].segments.every((s) => s.kind === "text")).toBe(true);
    expect(lines[2].lead).toBe(true);
    const text1 = lines[1].segments
      .filter((s) => s.kind === "text")
      .map((s) => (s as { text: string }).text)
      .join("");
    expect(text1).toContain("[9]");
  });

  it("summaryLines strips ** markers and bolds across a sentence boundary", () => {
    const lines = summaryLines(
      "**My read: Turo moved fees up. That reopens the wedge.** Plain tail here.",
      [],
    );
    const allText = lines
      .flatMap((l) => l.segments)
      .filter((s) => s.kind === "text")
      .map((s) => (s as { text: string }).text)
      .join(" ");
    expect(allText).not.toContain("**");
    expect(
      lines[0].segments.some((s) => s.kind === "text" && s.bold),
    ).toBe(true);
    expect(
      lines[1].segments.some((s) => s.kind === "text" && s.bold),
    ).toBe(true);
    const tail = lines[lines.length - 1];
    expect(tail.segments.some((s) => s.kind === "text" && !s.bold)).toBe(true);
  });
});

import { isSerializedReportLeak } from "./useCompetitorIntel";

describe("isSerializedReportLeak — serialized-dump predicate", () => {
  it("flags a bare stat_tiles/rows dump (with or without a title prefix / bullet)", () => {
    expect(isSerializedReportLeak('stat_tiles: [{"value":"$65.3B"}]')).toBe(true);
    expect(isSerializedReportLeak('rows: [{"brand":"Turo"}]')).toBe(true);
    expect(isSerializedReportLeak('- **rows:** [{"brand":"Turo"}]')).toBe(true);
    expect(isSerializedReportLeak('**Landscape**\n\nrows: [{"brand":"Turo"}]')).toBe(true);
    expect(isSerializedReportLeak('[{"brand":"Turo"},{"brand":"Kyte"}]')).toBe(true);
  });

  it("flags a dump that follows intro prose (leak line anywhere, not just at start)", () => {
    expect(isSerializedReportLeak('Here is the data:\nrows: [{"brand":"Turo"}]')).toBe(true);
  });

  it("does NOT flag legit markdown / prose", () => {
    expect(isSerializedReportLeak("## Landscape\n\nTuro leads on scale.")).toBe(false);
    expect(isSerializedReportLeak("See citations: [1, 2, 3] for sources.")).toBe(false);
    expect(isSerializedReportLeak("")).toBe(false);
    expect(isSerializedReportLeak("- Turo: dominant P2P marketplace.")).toBe(false);
  });
});

describe("CompetitorTabView — Landscape hides a raw-JSON leak (already-stored bad snapshot)", () => {
  it("renders the 'no table' empty state, never the raw serialized dump", () => {
    const leakBody =
      'stat_tiles: [{"value":"$65.3B","label":"US market"}]\nrows: [{"brand":"Turo","positioning":"P","gap":"G"}]';
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          landscape: {
            kind: "report",
            template: "landscape",
            title: "Upcar competitive landscape",
            blocks: [{ type: "markdown", body_md: leakBody }],
            sources: [],
          },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).not.toContain("$65.3B");
    expect(html).not.toContain("stat_tiles");
    expect(html).not.toContain('"brand":"Turo"');
    expect(html).toContain("has no table");
  });
});

describe("CompetitorTabView — error", () => {
  it("renders the error + a Retry button", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView data={null} loading={false} error="HTTP 500" onRetry={vi.fn()} />,
    );
    expect(html).toContain("HTTP 500");
    expect(html).toContain("Retry");
  });
});

describe("CompetitorTabView — custom competitors panel (2026-06-16)", () => {
  const onSave = async () => ({ brands: [] as string[], dropped: 0 });

  it("renders the panel (heading + chip + Add input) when customBrands is provided", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot()],
      custom_brands: ["Kyte"],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        customBrands={["Kyte"]}
        onSaveBrands={onSave}
      />,
    );
    expect(html).toContain("Competitors tracked");
    expect(html).toContain("Detected this week");
    expect(html).toContain("Turo");
    expect(html).toContain("Manual additions");
    expect(html).toContain("Kyte");
    expect(html).toContain("Add a competitor");
    expect(html).toContain("Remove Kyte");
  });

  it("does not make auto-detected competitors look manually removable", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot()],
      custom_brands: ["Turo", "Kyte"],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        customBrands={["Turo", "Kyte"]}
        onSaveBrands={onSave}
      />,
    );
    expect(html).toContain("Detected this week");
    expect(html).toContain("Turo");
    expect(html).toContain("Getaround");
    expect(html).toContain("Manual additions");
    expect(html).toContain("Kyte");
    expect(html).not.toContain("Remove Turo");
    expect(html).toContain("Remove Kyte");
  });

  it("shows the panel in the enabled-but-empty (first scan) state so a new tenant can preconfigure", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [],
      custom_brands: [],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        customBrands={[]}
        onSaveBrands={onSave}
      />,
    );
    expect(html).toContain("Competitors tracked");
    expect(html).toContain("No competitor scan yet");
  });

  it("REGRESSION (D4): hides the panel when customBrands is omitted (legacy call shape)", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [snapshot()],
      custom_brands: [],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).not.toContain("Competitors tracked");
    expect(html).toContain("Landscape");
  });
});

describe("CompetitorTabView — openable previous weeks (2026-06-17)", () => {
  const latest = snapshot();
  const past: CompetitorSnapshot = {
    week_bucket: "2026-06-01",
    created_at: "2026-06-01T09:05:00Z",
    delta: { added_brands: ["Kyte"], removed_brands: [], narrative_md: null },
    landscape: {
      kind: "report",
      template: "landscape",
      title: "Acme landscape — June 1",
      blocks: [
        {
          type: "recommendations",
          items: [
            { index: 1, label: "move", title: "Old-week move", body_md: "stale advice", citations: [] },
          ],
        },
        {
          type: "competitive_table",
          rows: [{ brand: "Kyte", positioning: "Delivery-first", gap: "Few cities" }],
        },
      ],
      sources: [],
    },
  };
  const data: CompetitorIntelPayload = {
    enabled: true,
    snapshots: [latest, past],
  };

  it("default render: history rows are <button>, no selected marker, no Back button", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} onAskAgent={noop} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("Week of Jun 1");
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain("Back to current week");
    expect(html).toContain("What changed this week");
    expect(html).toContain("Turo");
  });

  it("initialSelectedWeek seeds a history view: that week's report, Back button, aria-current, recs + tracking panel hidden", () => {
    const onSave = async () => ({ brands: [] as string[], dropped: 0 });
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
        customBrands={["Kyte"]}
        onSaveBrands={onSave}
        initialSelectedWeek="2026-06-01"
      />,
    );
    expect(html).toContain("Acme landscape — June 1");
    expect(html).toContain("Kyte");
    expect(html).not.toContain("Getaround");
    expect(html).toContain("Back to current week");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("What changed that week");
    expect(html).not.toContain("Recommended moves");
    expect(html).not.toContain("Old-week move");
    expect(html).not.toContain("Competitors tracked");
  });

  it("current-week view still shows the tracking panel when customBrands supplied", () => {
    const onSave = async () => ({ brands: [] as string[], dropped: 0 });
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={data}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
        customBrands={["Kyte"]}
        onSaveBrands={onSave}
      />,
    );
    expect(html).toContain("Competitors tracked");
    expect(html).not.toContain("Back to current week");
  });

  it("REGRESSION: omitting initialSelectedWeek is identical to the latest-only render", () => {
    const withProp = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} onAskAgent={noop} initialSelectedWeek={undefined} />,
    );
    const without = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} onAskAgent={noop} />,
    );
    expect(withProp).toBe(without);
  });
});

describe("useCompetitorIntel — pure block extractors", () => {
  it("competitiveRows / execSummaryProse / brandCount read the report blocks defensively", () => {
    const s = snapshot();
    expect(competitiveRows(s.landscape)?.map((r) => r.brand)).toEqual([
      "Turo",
      "Getaround",
    ]);
    expect(brandCount(s.landscape)).toBe(2);
    expect(execSummaryProse(s.landscape)).toBeNull();
    expect(competitiveRows({ kind: "report", blocks: [{ type: "competitive_table", rows: "nope" }] })).toBeNull();
    expect(competitiveRows(undefined)).toBeNull();
  });
});

import { shouldPollScan } from "./useCompetitorIntel";

describe("shouldPollScan — first-scan auto-poll gate", () => {
  it("polls only while a first scan is in flight (scanning + zero snapshots)", () => {
    expect(shouldPollScan({ enabled: true, snapshots: [], scan_in_progress: true })).toBe(true);
    expect(
      shouldPollScan({ enabled: true, snapshots: [snapshot()], scan_in_progress: true }),
    ).toBe(false);
    expect(shouldPollScan({ enabled: true, snapshots: [], scan_in_progress: false })).toBe(false);
    expect(shouldPollScan({ enabled: true, snapshots: [] })).toBe(false);
    expect(shouldPollScan(null)).toBe(false);
  });
});

import { materialMoves } from "./useCompetitorIntel";
import { stripTrailingWeekOf } from "./CompetitorTab";

describe("materialMoves extractor + 'What changed' lead", () => {
  const movesBlock = {
    type: "material_moves",
    items: [
      {
        competitor: "Turo",
        move: "Cut default NY host liability $1.25M → $75K",
        why_now: "A liability-cap collapse is host-Slack catnip for weeks.",
        citations: [1],
      },
      { competitor: "", move: "", why_now: "" },
    ],
  };

  it("extracts non-empty moves and drops empty ones", () => {
    const moves = materialMoves({ kind: "report", blocks: [movesBlock] });
    expect(moves).not.toBeNull();
    expect(moves).toHaveLength(1);
    expect(moves![0].competitor).toBe("Turo");
    expect(moves![0].citations).toEqual([1]);
  });

  it("returns null when no material_moves block is present", () => {
    expect(materialMoves({ kind: "report", blocks: [] })).toBeNull();
    expect(materialMoves(undefined)).toBeNull();
  });

  it("panel LEADS with material moves and shows roster as a footnote, not 'nothing changed'", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          delta: { added_brands: ["Kyte"], removed_brands: [], narrative_md: null },
          landscape: {
            kind: "report",
            template: "landscape",
            title: "Acme competitor landscape",
            blocks: [movesBlock],
            sources: [
              { n: 1, title: "Turo NY filing", url: "https://turo.com/ny", accessed_at: "2026-06-21" },
            ],
          },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("Cut default NY host liability");
    expect(html).toContain("A liability-cap collapse");
    expect(html).toContain("https://turo.com/ny");
    expect(html).toContain("New to the set");
    expect(html).not.toContain("No material moves detected");
    expect(html).not.toContain("No entrants or departures");
  });

  it("empty-state copy is 'No material moves detected' when delta exists but is flat", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          delta: { added_brands: [], removed_brands: [], narrative_md: null },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("No material moves detected");
  });
});

describe("stat-tile movement (#4)", () => {
  function withTiles(tiles: unknown[]): CompetitorIntelPayload {
    return {
      enabled: true,
      snapshots: [
        snapshot({
          landscape: {
            kind: "report",
            template: "landscape",
            title: "Acme",
            blocks: [{ type: "exec_summary", prose_md: "My read: x.", stat_tiles: tiles, citations: [] }],
            sources: [],
          },
        }),
      ],
    };
  }

  it("a tile with prior_value renders 'was X' and the as_of date", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={withTiles([{ value: "$75K", label: "Turo NY liability", prior_value: "$1.25M", as_of: "Jun 17" }])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(html).toContain("was $1.25M");
    expect(html).toContain("Jun 17");
  });

  it("a bare tile shows no fabricated movement", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={withTiles([{ value: "$8.4B", label: "US P2P market" }])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(html).toContain("$8.4B");
    expect(html).not.toContain("was ");
  });
});

describe("summary parser + cap (#3)", () => {
  it("does not orphan inline numbered-list markers", () => {
    const lines = summaryLines(
      "Two facts move the board: 1. Turo cuts liability for weeks. 2. Turo restructures tiers now.",
      [],
    );
    const texts = lines.map((l) => l.segments.map((s) => (s.kind === "text" ? s.text : "")).join(""));
    expect(texts.some((t) => /^\s*1\.\s*$/.test(t))).toBe(false);
    expect(texts.some((t) => /^\s*2\.\s*$/.test(t))).toBe(false);
    expect(texts.some((t) => /2\.\s*Turo restructures tiers/.test(t))).toBe(true);
  });

  it("caps the summary at 4 bullets with a Show-more toggle", () => {
    const longProse =
      "My read: lead. Alpha one. Bravo two. Charlie three. Delta four. Echo five. Foxtrot six.";
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          landscape: {
            kind: "report",
            template: "landscape",
            title: "Acme",
            blocks: [{ type: "exec_summary", prose_md: longProse, stat_tiles: [], citations: [] }],
            sources: [],
          },
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} />,
    );
    expect(html).toContain("Charlie three");
    expect(html).not.toContain("Delta four");
    expect(html).not.toContain("Echo five");
    expect(html).toContain(">Show more</button>");
    expect(html).not.toContain("Show 3 more");
  });
});

describe("stripTrailingWeekOf (#freebie)", () => {
  it("strips a trailing em/hyphen 'week of …' suffix", () => {
    expect(stripTrailingWeekOf("Upcar competitive landscape — week of 2026-06-15")).toBe(
      "Upcar competitive landscape",
    );
    expect(stripTrailingWeekOf("Acme - week of Jun 15")).toBe("Acme");
  });
  it("leaves a clean title untouched and never empties it", () => {
    expect(stripTrailingWeekOf("Acme competitor landscape")).toBe("Acme competitor landscape");
    expect(stripTrailingWeekOf("— week of 2026-06-15")).toBe("— week of 2026-06-15");
  });
});

import { recKey } from "./useCompetitorIntel";

describe("recommended-moves decision queue (#2)", () => {
  const recLandscape = {
    kind: "report",
    template: "landscape",
    title: "Acme",
    blocks: [
      {
        type: "recommendations",
        items: [
          { index: 1, label: "m", title: "Undercut Turo fee anxiety", body_md: "Publish a fee page.", citations: [] },
          { index: 2, label: "m", title: "Seed Kyte orphans", body_md: "Email the list.", citations: [] },
        ],
      },
    ],
    sources: [],
  };

  function dataWith(decisions = {}, priorTitles: string[] = []): CompetitorIntelPayload {
    const snaps = [
      snapshot({ landscape: recLandscape }),
    ];
    if (priorTitles.length) {
      snaps.push(
        snapshot({
          week_bucket: "2026-06-01",
          landscape: {
            ...recLandscape,
            blocks: [
              {
                type: "recommendations",
                items: priorTitles.map((t, i) => ({ index: i + 1, label: "m", title: t, body_md: "x", citations: [] })),
              },
            ],
          },
        }),
      );
    }
    return { enabled: true, snapshots: snaps, rec_decisions: decisions };
  }

  it("shows Act/Monitor/Dismiss controls when onSaveDecision is provided", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={dataWith()}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
        onSaveDecision={async () => ({})}
      />,
    );
    expect(html).toContain("Act now");
    expect(html).toContain("Monitor");
    expect(html).toContain("Dismiss");
    expect(html).toContain("New");
  });

  it("renders the persisted status chip + tags a repeated rec", () => {
    const decisions = {
      [recKey("Undercut Turo fee anxiety")]: { status: "act" as const, title: "Undercut Turo fee anxiety", updated_at: "x" },
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={dataWith(decisions, ["Undercut Turo fee anxiety"])}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
        recDecisions={decisions}
        onSaveDecision={async () => ({})}
      />,
    );
    expect(html).toContain("Acting");
    expect(html).toContain("Repeated");
  });

  it("collapses dismissed moves behind a toggle", () => {
    const decisions = {
      [recKey("Seed Kyte orphans")]: { status: "dismiss" as const, title: "Seed Kyte orphans", updated_at: "x" },
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={dataWith(decisions)}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
        recDecisions={decisions}
        onSaveDecision={async () => ({})}
      />,
    );
    expect(html).toContain("Show 1 dismissed");
    expect(html).not.toContain("Email the list");
    expect(html).toContain("Undercut Turo fee anxiety");
  });

  it("keeps Ask PM / Ask Growth lead but hides decision controls when read-only", () => {
    const html = renderToStaticMarkup(
      <CompetitorTabView
        data={dataWith()}
        loading={false}
        error={null}
        onRetry={noop}
        onAskAgent={noop}
      />,
    );
    expect(html).toContain("Ask PM");
    expect(html).not.toContain("Act now");
  });

  it("leads the page with the decision queue (recs render before the Summary card)", () => {
    const data: CompetitorIntelPayload = {
      enabled: true,
      snapshots: [
        snapshot({
          landscape: {
            ...recLandscape,
            blocks: [
              ...recLandscape.blocks,
              { type: "exec_summary", prose_md: "My read: do x.", stat_tiles: [], citations: [] },
            ],
          },
        }),
      ],
      rec_decisions: {},
    };
    const html = renderToStaticMarkup(
      <CompetitorTabView data={data} loading={false} error={null} onRetry={noop} onAskAgent={noop} onSaveDecision={async () => ({})} />,
    );
    expect(html.indexOf("Recommended moves")).toBeLessThan(
      html.indexOf("What changed this week"),
    );
  });
});
