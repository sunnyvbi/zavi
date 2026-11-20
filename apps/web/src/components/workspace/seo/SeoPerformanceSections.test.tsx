
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SeoPerformanceSections, LabRun } from "./SeoPerformanceSections";
import { FieldVitals } from "./FieldVitals";
import { CategoryDials } from "./CategoryDials";
import { AgentReadiness } from "./AgentReadiness";
import { DeliveryGapLine } from "./DeliveryGap";
import { Opportunities } from "./Opportunities";
import { fmtBytes, fmtMs, categoryScore100, vitalBand } from "./format";
import type { LabCategory, SeoPerformanceReport } from "./types";

const html = (el: React.ReactElement<any>) => renderToStaticMarkup(el);
const text = (el: React.ReactElement<any>) =>
  html(el)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const okField = {
  state: "ok" as const,
  scope: "origin" as const,
  key: "https://example.com",
  collection_period: {
    firstDate: { year: 2026, month: 8, day: 17 },
    lastDate: { year: 2026, month: 9, day: 13 },
  },
  metrics: {
    largest_contentful_paint: { p75: 3600, histogram: [] },
    interaction_to_next_paint: { p75: 389, histogram: [] },
    cumulative_layout_shift: { p75: 0.34, histogram: [] },
    first_contentful_paint: { p75: 2700, histogram: [] },
    experimental_time_to_first_byte: { p75: 1700, histogram: [] },
  },
};

describe("FieldVitals — all four states of the CrUX lane", () => {
  it("ok draws the five metrics with their measured values and the real window", () => {
    const out = text(<FieldVitals field={okField} />);
    expect(out).toContain("Largest paint");
    expect(out).toContain("3.6 s");
    expect(out).toContain("389 ms");
    expect(out).toContain("0.34");
    expect(out).toContain("2.7 s");
    expect(out).toContain("1.7 s");
    expect(out).toContain("Aug 17");
    expect(out).toContain("Sep 13");
    expect(out).not.toContain("last 28 days");
  });

  it("ok states Google's own pass/fail verdict, and never by colour alone", () => {
    const out = text(<FieldVitals field={okField} />);
    expect(out).toContain("Core Web Vitals: failed");
    expect(out).toContain(", poor");
    expect(out).toContain(", needs work");
  });

  it("ok falls back to CrUX's own window when no collection period came back", () => {
    const out = text(
      <FieldVitals field={{ ...okField, collection_period: undefined }} />,
    );
    expect(out).toContain("last 28 days");
  });

  it("ok withholds the verdict when a core vital is missing", () => {
    const out = text(
      <FieldVitals
        field={{
          ...okField,
          metrics: {
            largest_contentful_paint: { p75: 1900 },
            first_contentful_paint: { p75: 1200 },
          },
        }}
      />,
    );
    expect(out).toContain("1.9 s");
    expect(out).not.toContain("Core Web Vitals:");
  });

  it("NO DATA is written as a finding, not as an error", () => {
    const out = text(
      <FieldVitals
        field={{ state: "no_data", tried: ["https://example.com/pricing", "https://example.com"] }}
      />,
    );
    expect(out).toContain("Google has not seen enough visitors to measure you yet");
    expect(out).toContain("traffic threshold it does not disclose");
    expect(out).toContain("That is a finding, not a gap");
    expect(out).toContain("example.com/pricing");
    expect(out.toLowerCase()).not.toContain("error");
    expect(out.toLowerCase()).not.toContain("failed");
  });

  it("no_data survives a payload with no `tried` list", () => {
    const out = text(<FieldVitals field={{ state: "no_data" }} />);
    expect(out).toContain("Google has not seen enough visitors");
    expect(out).not.toContain("Asked about");
  });

  it("not_configured blames our setup, not the customer's site", () => {
    const out = text(<FieldVitals field={{ state: "not_configured" }} />);
    expect(out).toContain("Not reading Google");
    expect(out).toContain("setup step on our side");
  });

  it("unavailable says the read failed and humanises the reason code", () => {
    const out = text(
      <FieldVitals field={{ state: "unavailable", reason: "crux_http_500" }} />,
    );
    expect(out).toContain("Couldn't reach Google");
    expect(out).not.toContain("crux_http_500");
    expect(out).toContain("Crux http 500");
  });

  it("an `ok` envelope with nothing measurable inside does not draw an empty grid", () => {
    const out = text(<FieldVitals field={{ state: "ok", metrics: {} }} />);
    expect(out).toContain("no measurements");
    expect(out).not.toContain("Largest paint");
  });

  it("renders nothing at all when the field half is absent", () => {
    expect(html(<FieldVitals field={undefined} />)).toBe("");
  });
});

describe("CategoryDials — generic, and a fraction is never a ring", () => {
  const categories: LabCategory[] = [
    { id: "performance", title: "Performance", score: 0.42 },
    { id: "accessibility", title: "Accessibility", score: 0.91 },
    { id: "best-practices", title: "Best Practices", score: 1 },
    { id: "seo", title: "SEO", score: 0.92 },
    { id: "some-fraction", title: "Some Fraction", score: 0.67, display_mode: "fraction" },
    { id: "future-thing", title: "Future Thing", score: 0.55 },
  ];

  it("draws every category a REAL response carries, none of which has a display mode", () => {
    const out = text(<CategoryDials categories={categories.slice(0, 4)} />);
    expect(out).toContain("Speed: 42 out of 100");
    expect(out).toContain("Accessible: 91 out of 100");
    expect(out).toContain("Best practice: 100 out of 100");
    expect(out).toContain("On-page SEO: 92 out of 100");
  });

  it("draws a ring for every non-fraction category, including unknown ones", () => {
    const out = text(<CategoryDials categories={categories} />);
    expect(out).toContain("Speed");
    expect(out).toContain("Accessible");
    expect(out).toContain("Best practice");
    expect(out).toContain("On-page SEO");
    expect(out).toContain("Future Thing");
  });

  it("A FRACTION CATEGORY IS NEVER DRAWN AS A RING", () => {
    const out = text(<CategoryDials categories={categories} />);
    expect(out).not.toContain("Some Fraction");
    expect(out).not.toContain("67");
  });

  it("scores read as 0-100 and carry their band in words", () => {
    const out = text(<CategoryDials categories={categories} />);
    expect(out).toContain("Speed: 42 out of 100, poor");
    expect(out).toContain("Accessible: 91 out of 100, good");
  });

  it("an unscored category shows a dash, never a zero", () => {
    const out = text(<CategoryDials categories={[{ id: "seo", score: null }]} />);
    expect(out).toContain("not scored");
    expect(out).not.toContain("0 out of 100");
  });

  it("renders nothing when every category is a fraction", () => {
    expect(
      html(<CategoryDials categories={[{ id: "some-fraction", display_mode: "fraction", score: 0.5 }]} />),
    ).toBe("");
  });
});

describe("AgentReadiness", () => {
  const readiness = {
    checks: [
      {
        id: "llms_txt",
        label: "Publishes an llms.txt file",
        state: "fail" as const,
        detail: "No /llms.txt at the site root.",
      },
      {
        id: "ai_crawlers",
        label: "Lets AI crawlers in",
        state: "pass" as const,
        detail: "robots.txt names no AI crawler, so none is blocked.",
      },
      {
        id: "server_rendered",
        label: "Serves real text without JavaScript",
        state: "pass" as const,
        detail: "412 words in the server HTML on the homepage.",
      },
      {
        id: "layout_stable",
        label: "Layout stays put while loading",
        state: "unknown" as const,
        detail: "Google has no layout-shift reading for this site yet.",
      },
    ],
    passed: 2,
    applicable: 3,
  };

  it("RENDERS NOTHING when the readiness data is absent", () => {
    expect(html(<AgentReadiness readiness={null} />)).toBe("");
    expect(html(<AgentReadiness readiness={undefined} />)).toBe("");
    expect(html(<AgentReadiness readiness={{ checks: [] }} />)).toBe("");
  });

  it("THE DENOMINATOR EXCLUDES WHAT WE COULD NOT MEASURE", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("2");
    expect(out).toContain("of 3 we could check");
    expect(out).not.toContain("of 4");
  });

  it("an unknown check is never counted as a failure, in words or in the count", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("Layout stays put while loading , not measured");
    expect(out).not.toContain("Layout stays put while loading , failed");
  });

  it("states pass, fail and not-measured in words, not by colour", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("Publishes an llms.txt file , failed");
    expect(out).toContain("Lets AI crawlers in , passed");
  });

  it("surfaces the backend's evidence sentence verbatim", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("No /llms.txt at the site root.");
    expect(out).toContain("412 words in the server HTML on the homepage.");
    expect(out).toContain("robots.txt names no AI crawler, so none is blocked.");
  });

  it("DOES NOT PRESENT ITSELF AS GOOGLE'S SCORE", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("Zavi's own check");
    expect(out).toContain("Zavi works this out from your own site");
    expect(out).toContain("not meant to match");
    expect(out).toContain("neither is a Search ranking signal");
    expect(out).not.toContain("Lighthouse");
    expect(out).not.toContain("Chrome 150");
    expect(out).not.toContain("Experimental");
  });

  it("says the layout fix moves two things only when that check is present", () => {
    expect(text(<AgentReadiness readiness={readiness} />)).toContain("moves both");
    const withoutLayout = text(
      <AgentReadiness
        readiness={{
          checks: readiness.checks.filter((c) => c.id !== "layout_stable"),
          passed: 2,
          applicable: 3,
        }}
      />,
    );
    expect(withoutLayout).not.toContain("moves both");
  });

  it("falls back to counting the checks when the payload omits the numbers", () => {
    const out = text(<AgentReadiness readiness={{ checks: readiness.checks }} />);
    expect(out).toContain("of 3 we could check");
  });

  it("drops the fraction rather than printing 0 of 0 when nothing was measurable", () => {
    const out = text(
      <AgentReadiness
        readiness={{
          checks: [
            { id: "layout_stable", label: "Layout stays put while loading", state: "unknown" },
          ],
          passed: 0,
          applicable: 0,
        }}
      />,
    );
    expect(out).toContain("Layout stays put while loading , not measured");
    expect(out).not.toContain("of 0");
  });
});

describe("Opportunities", () => {
  const real: Parameters<typeof Opportunities>[0]["opportunities"] = [
    {
      id: "mainthread-work-breakdown",
      title: "Minimise main-thread work",
      score: 0.3,
      metricSavings: [{ metric: "TBT", value: 1150, unit: "ms" }],
      savingsMs: null,
      savingsBytes: null,
    },
    {
      id: "layout-shifts",
      title: "Avoid large layout shifts",
      score: 0,
      metricSavings: [{ metric: "CLS", value: 0.318, unit: "score" }],
      savingsMs: null,
      savingsBytes: null,
    },
    {
      id: "image-delivery-insight",
      title: "Improve image delivery",
      score: 0.4,
      metricSavings: [{ metric: "LCP", value: 1100, unit: "ms" }],
      savingsMs: null,
      savingsBytes: null,
    },
    {
      id: "render-blocking-insight",
      title: "Render blocking requests",
      score: 0.5,
      metricSavings: [
        { metric: "LCP", value: 900, unit: "ms" },
        { metric: "FCP", value: 900, unit: "ms" },
      ],
      savingsMs: null,
      savingsBytes: null,
    },
    {
      id: "unused-css-rules",
      title: "Reduce unused CSS",
      score: 0.6,
      metricSavings: [
        { metric: "FCP", value: 250, unit: "ms" },
        { metric: "LCP", value: 150, unit: "ms" },
      ],
      savingsMs: null,
      savingsBytes: 39936,
    },
    {
      id: "unused-javascript",
      title: "Reduce unused JavaScript",
      score: 0.5,
      metricSavings: [],
      savingsMs: null,
      savingsBytes: 424673,
    },
  ];

  it("RENDERS THE ORDER IT RECEIVED — the backend owns the ranking", () => {
    const out = text(<Opportunities opportunities={real} />);
    const order = [
      "Minimise main-thread work",
      "Avoid large layout shifts",
      "Improve image delivery",
      "Render blocking requests",
      "Reduce unused CSS",
      "Reduce unused JavaScript",
    ].map((t) => out.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the layout-shift row survives, though it carries no millisecond saving", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out.indexOf("Avoid large layout shifts")).toBeLessThan(
      out.indexOf("Reduce unused JavaScript"),
    );
  });

  it("FORMATS OFF `unit`, so a layout score is never printed as milliseconds", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).toContain("0.32");
    expect(out).not.toContain("0.318 ms");
    expect(out).not.toContain("0.32 ms");
  });

  it("says what each fix recovers, per metric, in human units", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).toContain("Google's estimate, one fix at a time");
    expect(out).toContain("1.1 s");
    expect(out).toContain("900 ms");
    expect(out).toContain("250 ms");
    expect(out).toContain("TBT");
    expect(out).toContain("Main-thread blocking");
    expect(out).toContain("Layout shift");
  });

  it("shows BOTH metrics of a multi-metric row, and says they do not add up", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).toContain("LCP");
    expect(out).toContain("FCP");
    expect(out).toContain("one page load measured twice");
    expect(out).toContain("not meant to be added together");
  });

  it("INVENTS NO BLENDED TOTAL", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).not.toContain("1.8 s");
    expect(out).not.toContain("Total");
    expect(out).not.toContain("in total");
  });

  it("keeps a row with NO metric savings, carrying its byte figure", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).toContain("Reduce unused JavaScript");
    expect(out).toContain("415 KB smaller");
  });

  it("does not render `score`, which is a gradient and would read as a verdict", () => {
    const out = text(<Opportunities opportunities={real} />);
    expect(out).not.toContain("0.5");
    expect(out).not.toContain("50%");
    expect(out).not.toContain("✗");
  });

  it("falls back to the legacy estimate on a row that only has one", () => {
    const out = text(
      <Opportunities
        opportunities={[
          { id: "legacy", title: "An older audit", metricSavings: [], savingsMs: 1400 },
        ]}
      />,
    );
    expect(out).toContain("1.4 s");
    expect(out).not.toContain("LCP");
  });

  it("keeps a row that states nothing at all, rather than hiding a ranked fix", () => {
    const out = text(
      <Opportunities
        opportunities={[
          { id: "x", title: "Something Lighthouse flagged", metricSavings: [] },
        ]}
      />,
    );
    expect(out).toContain("Something Lighthouse flagged");
  });

  it("tolerates a malformed or zero saving without printing a fake one", () => {
    const out = text(
      <Opportunities
        opportunities={[
          {
            id: "odd",
            title: "Odd row",
            metricSavings: [
              { metric: "LCP", value: 0, unit: "ms" },
              { metric: "INP", value: Number.NaN, unit: "ms" },
              { metric: "CLS", value: 0.2, unit: "score" },
            ],
          },
        ]}
      />,
    );
    expect(out).toContain("Odd row");
    expect(out).toContain("0.20");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("0 ms");
  });

  it("renders nothing when the lab returned no opportunities", () => {
    expect(html(<Opportunities opportunities={[]} />)).toBe("");
    expect(html(<Opportunities opportunities={undefined} />)).toBe("");
  });
});

describe("LabRun — all three states of the lab lane", () => {
  it("not_configured says it is our setup step", () => {
    const out = text(<LabRun lab={{ state: "not_configured" }} />);
    expect(out).toContain("Not running the speed test yet");
    expect(out).toContain("setup step on our side");
  });

  it("unavailable humanises the reason", () => {
    const out = text(<LabRun lab={{ state: "unavailable", reason: "quota-exhausted" }} />);
    expect(out).toContain("Couldn't run the page test");
    expect(out).toContain("Quota exhausted");
    expect(out).not.toContain("quota-exhausted");
  });

  it("ok with no pages says so rather than drawing empty sections", () => {
    const out = text(<LabRun lab={{ state: "ok", pages: [] }} />);
    expect(out).toContain("No page test came back");
  });

  it("ok names the page and the device it simulated in plain English", () => {
    const out = text(
      <LabRun
        lab={{
          state: "ok",
          pages: [
            {
              requested_url: "https://www.example.com/",
              final_url: "https://www.example.com/",
              strategy: "mobile",
              lighthouse_version: "13.3.0",
              fetch_time: "2026-09-14T00:00:00Z",
              categories: [{ id: "performance", title: "Performance", score: 0.3 }],
              agentic_browsing: null,
              opportunities: [],
            },
          ],
        }}
      />,
    );
    expect(out).toContain("www.example.com");
    expect(out).toContain("simulated phone");
    expect(out).not.toContain("mobile");
    expect(out).toContain("Speed");
  });

  it("renders nothing when the lab half is absent", () => {
    expect(html(<LabRun lab={undefined} />)).toBe("");
  });
});

describe("the warming state", () => {
  it("says we are measuring, and does not look like an error", () => {
    const out = text(<FieldVitals field={undefined} warming />);
    expect(out).toContain("Measuring your site now");
    expect(out).toContain("takes a few minutes");
    expect(out.toLowerCase()).not.toContain("error");
    expect(out.toLowerCase()).not.toContain("couldn't");
  });

  it("NEVER says Google has no data while we are still asking Google", () => {
    const out = text(<FieldVitals field={{ state: "no_data" }} warming />);
    expect(out).toContain("Measuring your site now");
    expect(out).not.toContain("Google has not seen enough visitors");
  });

  it("outranks a previous run's failure, which is no longer the current story", () => {
    const field = text(
      <FieldVitals field={{ state: "unavailable", reason: "crux_http_500" }} warming />,
    );
    expect(field).toContain("Measuring your site now");
    expect(field).not.toContain("Crux http 500");

    const lab = text(<LabRun lab={{ state: "unavailable", reason: "timeout" }} warming />);
    expect(lab).toContain("Running the page test now");
  });

  it("the lab lane has its own measuring state", () => {
    const out = text(<LabRun lab={{ state: "ok", pages: [] }} warming />);
    expect(out).toContain("Running the page test now");
    expect(out).toContain("real browser");
    expect(out).not.toContain("No page test came back");
  });

  it("KEEPS cached numbers on screen and says a fresher read is coming", () => {
    const out = text(<FieldVitals field={okField} warming />);
    expect(out).toContain("3.6 s");
    expect(out).toContain("389 ms");
    expect(out).toContain("Measuring again now");
    expect(out).not.toContain("Measuring your site now");
  });

  it("keeps cached lab scores too, with the same caveat", () => {
    const out = text(
      <LabRun
        lab={{
          state: "ok",
          pages: [
            {
              requested_url: "https://example.com/",
              final_url: "https://example.com/",
              strategy: "mobile",
              lighthouse_version: "13.3.0",
              fetch_time: "2026-09-14T00:00:00Z",
              categories: [{ id: "performance", title: "Performance", score: 0.3 }],
              agentic_browsing: null,
              opportunities: [],
            },
          ],
        }}
        warming
      />,
    );
    expect(out).toContain("Speed");
    expect(out).toContain("Running the test again now");
  });

  it("a missing flag simply means not warming", () => {
    const out = text(<FieldVitals field={{ state: "no_data" }} />);
    expect(out).toContain("Google has not seen enough visitors");
    expect(out).not.toContain("Measuring");
  });

  it("the four original states are untouched when nothing is in flight", () => {
    expect(text(<FieldVitals field={okField} warming={false} />)).toContain("3.6 s");
    expect(text(<FieldVitals field={{ state: "no_data" }} warming={false} />)).toContain(
      "Google has not seen enough visitors",
    );
    expect(text(<FieldVitals field={{ state: "not_configured" }} warming={false} />)).toContain(
      "Not reading Google",
    );
    expect(
      text(<FieldVitals field={{ state: "unavailable", reason: "quota_exceeded" }} warming={false} />),
    ).toContain("Couldn't reach Google");
  });
});

describe("SeoPerformanceSections", () => {
  it("absence 1 — no performance field at all renders NOTHING", () => {
    expect(html(<SeoPerformanceSections report={null} />)).toBe("");
    expect(html(<SeoPerformanceSections report={undefined} />)).toBe("");
    expect(html(<SeoPerformanceSections report={{ fetched_at: "2026-09-14T00:00:00Z" }} />)).toBe("");
    expect(html(<SeoPerformanceSections report={{ warming: false }} />)).toBe("");
  });

  it("absence 2 — warming with nothing in it is the measuring state, both lanes", () => {
    const out = text(<SeoPerformanceSections report={{ warming: true }} />);
    expect(out).toContain("Measuring your site now");
    expect(out).toContain("Running the page test now");
  });

  it("absence 3 — not warming, with states in it, defers to each state", () => {
    const out = text(
      <SeoPerformanceSections
        report={{
          warming: false,
          field: { state: "no_data" },
          lab: { state: "not_configured" },
        }}
      />,
    );
    expect(out).toContain("Google has not seen enough visitors");
    expect(out).toContain("Not running the speed test yet");
    expect(out).not.toContain("Measuring your site now");
  });

  const fullReport: SeoPerformanceReport = {
    field: { state: "no_data", tried: ["https://example.com"] },
    lab: {
      state: "ok",
      pages: [
        {
          requested_url: "https://example.com/",
          final_url: "https://example.com/",
          strategy: "mobile",
          lighthouse_version: "13.4.1",
          fetch_time: "2026-09-14T00:00:00Z",
          categories: [{ id: "performance", title: "Performance", score: 0.42 }],
          agentic_browsing: null,
          opportunities: [{ id: "unused-js", title: "Ship less unused JavaScript", savingsMs: 2100 }],
        },
      ],
    },
    agent_readiness: {
      checks: [
        { id: "llms_txt", label: "Publishes an llms.txt file", state: "fail", detail: "No /llms.txt." },
      ],
      passed: 0,
      applicable: 1,
    },
    fetched_at: "2026-09-14T00:00:00Z",
  };

  it("renders every lane, in the locked order", () => {
    const out = text(<SeoPerformanceSections report={fullReport} />);
    const order = [
      "Google has not seen enough visitors",
      "Lab run",
      "Can an AI agent use the site?",
      "Biggest wins on this page",
    ].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("one lane missing does not suppress the others", () => {
    const out = text(
      <SeoPerformanceSections report={{ field: { state: "no_data" } }} />,
    );
    expect(out).toContain("Google has not seen enough visitors");
    expect(out).not.toContain("Lab run");
    expect(out).not.toContain("Can an AI agent use the site?");
  });

  it("keeps agent readiness when the lab run is not configured at all", () => {
    const out = text(
      <SeoPerformanceSections
        report={{
          lab: { state: "not_configured" },
          agent_readiness: {
            checks: [{ id: "llms_txt", label: "Publishes an llms.txt file", state: "pass" }],
            passed: 1,
            applicable: 1,
          },
        }}
      />,
    );
    expect(out).toContain("Not running the speed test yet");
    expect(out).toContain("Can an AI agent use the site?");
    expect(out).toContain("Publishes an llms.txt file , passed");
  });

  it("renders readiness alone when it is the only thing that came back", () => {
    const out = text(
      <SeoPerformanceSections
        report={{
          agent_readiness: {
            checks: [{ id: "ai_crawlers", label: "Lets AI crawlers in", state: "pass" }],
            passed: 1,
            applicable: 1,
          },
        }}
      />,
    );
    expect(out).toContain("Can an AI agent use the site?");
  });
});

describe("format — the numbers behind the panel", () => {
  it("uses Google's published Core Web Vitals thresholds", () => {
    expect(vitalBand("largest_contentful_paint", 2500)).toBe("pass");
    expect(vitalBand("largest_contentful_paint", 2501)).toBe("warn");
    expect(vitalBand("largest_contentful_paint", 4001)).toBe("fail");
    expect(vitalBand("interaction_to_next_paint", 200)).toBe("pass");
    expect(vitalBand("interaction_to_next_paint", 501)).toBe("fail");
    expect(vitalBand("cumulative_layout_shift", 0.1)).toBe("pass");
    expect(vitalBand("cumulative_layout_shift", 0.26)).toBe("fail");
    expect(vitalBand("first_contentful_paint", 1800)).toBe("pass");
    expect(vitalBand("experimental_time_to_first_byte", 800)).toBe("pass");
  });

  it("reads a Lighthouse score on the 0-1 scale Google actually returns", () => {
    expect(categoryScore100(0.42)).toBe(42);
    expect(categoryScore100(0.91)).toBe(91);
    expect(categoryScore100(0.92)).toBe(92);
    expect(categoryScore100(0)).toBe(0);
  });

  it("a PERFECT score of 1 is 100, not 1", () => {
    expect(categoryScore100(1)).toBe(100);
  });

  it("no score stays no score — never a zero", () => {
    expect(categoryScore100(null)).toBe(null);
    expect(categoryScore100(undefined)).toBe(null);
    expect(categoryScore100(Number.NaN)).toBe(null);
    expect(categoryScore100(Number.POSITIVE_INFINITY)).toBe(null);
  });

  it("formats durations and weights the way a founder says them", () => {
    expect(fmtMs(389)).toBe("389 ms");
    expect(fmtMs(1400)).toBe("1.4 s");
    expect(fmtMs(12400)).toBe("12 s");
    expect(fmtBytes(900)).toBe("900 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(1153434)).toBe("1.1 MB");
  });
  it("treats null halves exactly like absent ones", () => {
    expect(html(<SeoPerformanceSections report={{ field: null, lab: null }} />)).toBe("");
    expect(html(<SeoPerformanceSections report={{ field: null, lab: null, warming: false }} />)).toBe("");
  });

  it("shows the measuring state when null halves arrive mid-warm", () => {
    const t = text(<SeoPerformanceSections report={{ field: null, lab: null, warming: true }} />);
    expect(t).toMatch(/measuring/i);
    expect(t).not.toMatch(/enough visitors/i);
  });
});

describe("Opportunities — named culprits and who can fix them", () => {
  const withCulprits: Parameters<typeof Opportunities>[0]["opportunities"] = [
    {
      id: "mainthread-work-breakdown",
      title: "Minimise main-thread work",
      metricSavings: [{ metric: "TBT", value: 1350, unit: "ms" }],
      culprits: [
        {
          kind: "third_party",
          label: "Google Tag Manager",
          detail: "gtm.js blocked the main thread for 430 ms after it loaded.",
          owner: "founder",
          bytes: 92160,
          wastedBytes: null,
        },
        {
          kind: "script",
          label: "app.bundle.js",
          detail: "620 ms of script evaluation on your own bundle.",
          owner: "developer",
          bytes: 512000,
          wastedBytes: 204800,
        },
      ],
    },
  ];

  it("NAMES THE CULPRITS instead of stopping at the humanised audit id", () => {
    const out = text(<Opportunities opportunities={withCulprits} />);
    expect(out).toContain("Google Tag Manager");
    expect(out).toContain("app.bundle.js");
  });

  it("renders the backend's evidence sentence verbatim, not a paraphrase", () => {
    const out = text(<Opportunities opportunities={withCulprits} />);
    expect(out).toContain("gtm.js blocked the main thread for 430 ms after it loaded.");
    expect(out).toContain("620 ms of script evaluation on your own bundle.");
  });

  it("MARKS THE OWNER IN WORDS — a screen reader gets it, not just the eye", () => {
    const out = text(<Opportunities opportunities={withCulprits} />);
    expect(out).toContain("No developer needed");
    expect(out).toContain("Needs a developer");
    expect(out.indexOf("Google Tag Manager")).toBeLessThan(out.indexOf("No developer needed"));
    expect(out.indexOf("No developer needed")).toBeLessThan(out.indexOf("app.bundle.js"));
  });

  it("states a culprit's weight, preferring the unused half of the bytes", () => {
    const out = text(<Opportunities opportunities={withCulprits} />);
    expect(out).toContain("200 KB unused");
    expect(out).toContain("90 KB");
  });

  it("invents no owner for a culprit the backend did not classify", () => {
    const out = text(
      <Opportunities
        opportunities={[
          {
            id: "x",
            title: "Something",
            culprits: [{ label: "unknown.js", detail: "It is 40 KB." }],
          },
        ]}
      />,
    );
    expect(out).toContain("unknown.js");
    expect(out).not.toContain("developer");
  });

  it("SAYS WHAT IT CUT rather than silently dropping a long culprit list", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      label: `thing-${i}.js`,
      detail: `Evidence ${i}.`,
      owner: "developer" as const,
    }));
    const out = text(
      <Opportunities opportunities={[{ id: "x", title: "A row", culprits: many }]} />,
    );
    expect(out).toContain("thing-0.js");
    expect(out).toContain("thing-3.js");
    expect(out).not.toContain("thing-4.js");
    expect(out).toContain("3 more like these on this page");
  });

  it("skips an empty culprit rather than drawing a blank bullet", () => {
    const out = html(
      <Opportunities
        opportunities={[
          {
            id: "x",
            title: "A row",
            culprits: [{ label: "   ", detail: "" }, { label: "real.js" }],
          },
        ]}
      />,
    );
    expect(out).toContain("real.js");
    expect(out.match(/<li/g)?.length).toBe(2);
  });

  it("A PAYLOAD WITH NO CULPRITS RENDERS EXACTLY AS IT DID BEFORE", () => {
    const legacy = html(
      <Opportunities
        opportunities={[
          {
            id: "mainthread-work-breakdown",
            title: "Minimise main-thread work",
            metricSavings: [{ metric: "TBT", value: 1350, unit: "ms" }],
          },
        ]}
      />,
    );
    expect(legacy).not.toContain("No developer needed");
    expect(legacy).not.toContain("Needs a developer");
    expect(legacy).not.toContain("more like");
    expect(legacy).toContain("Minimise main-thread work");
    expect(legacy).toContain("1.4 s");
    const emptyList = html(
      <Opportunities
        opportunities={[
          {
            id: "mainthread-work-breakdown",
            title: "Minimise main-thread work",
            metricSavings: [{ metric: "TBT", value: 1350, unit: "ms" }],
            culprits: [],
          },
        ]}
      />,
    );
    expect(emptyList).toBe(legacy);
  });
});

describe("Opportunities — the header no longer promises a banked gain", () => {
  const three: Parameters<typeof Opportunities>[0]["opportunities"] = [
    { id: "a", title: "A", metricSavings: [{ metric: "TBT", value: 1350, unit: "ms" }] },
    { id: "b", title: "B", metricSavings: [{ metric: "LCP", value: 950, unit: "ms" }] },
    { id: "c", title: "C", metricSavings: [{ metric: "FCP", value: 950, unit: "ms" }] },
  ];

  it("THE OLD HEADER IS GONE", () => {
    const out = text(<Opportunities opportunities={three} />);
    expect(out).not.toContain("What it recovers");
    expect(out).toContain("Google's estimate, one fix at a time");
  });

  it("says these are lab estimates for this page, and refuses the addition", () => {
    const out = text(<Opportunities opportunities={three} />);
    expect(out).toContain("Google's estimate for that one fix on this page");
    expect(out).toContain("not a gain already banked");
    expect(out).toContain("not meant to be added together");
  });

  it("PRINTS NO SUMMED TOTAL, on a list whose rows are begging to be added", () => {
    const out = text(<Opportunities opportunities={three} />);
    expect(out).not.toContain("3.3 s");
    expect(out).not.toContain("3.2 s");
    expect(out).not.toContain("3250");
    expect(out).not.toMatch(/total/i);
    expect(out).not.toMatch(/altogether|combined|in all/i);
  });
});

describe("DeliveryGapLine — the lab and real visitors disagreeing", () => {
  const diverged = {
    lab_ms: 3300,
    field_ms: 8100,
    field_scope: "origin" as const,
    state: "diverged" as const,
    note: "The lab loads this page on a clean simulated phone; the field number is what real Chrome users recorded over the last 28 days.",
  };

  it("renders the gap, both measured numbers, and the note VERBATIM", () => {
    const out = text(<DeliveryGapLine gap={diverged} />);
    expect(out).toContain("The lab test and real visitors disagree");
    expect(out).toContain("3.3 s");
    expect(out).toContain("8.1 s");
    expect(out).toContain("across your whole site");
    expect(out).toContain(diverged.note);
  });

  it("STATES NO DIFFERENCE — a subtraction reads as a number Google measured", () => {
    const out = text(<DeliveryGapLine gap={diverged} />);
    expect(out).not.toContain("4.8 s");
    expect(out).not.toMatch(/slower by|2\.5x|times slower/i);
  });

  it("renders NOTHING when there is no gap, or the two agree", () => {
    expect(html(<DeliveryGapLine gap={null} />)).toBe("");
    expect(html(<DeliveryGapLine gap={undefined} />)).toBe("");
    expect(html(<DeliveryGapLine gap={{ ...diverged, state: "aligned" }} />)).toBe("");
  });

  it("renders nothing when a divergence carries nothing measurable", () => {
    expect(html(<DeliveryGapLine gap={{ state: "diverged" }} />)).toBe("");
    expect(
      html(<DeliveryGapLine gap={{ state: "diverged", lab_ms: Number.NaN, note: "  " }} />),
    ).toBe("");
  });

  it("survives a partial gap without printing a fake half", () => {
    const out = text(<DeliveryGapLine gap={{ state: "diverged", field_ms: 8100 }} />);
    expect(out).toContain("8.1 s");
    expect(out).not.toContain("simulated phone");
  });

  it("sits with the vitals on the whole panel, and is absent when null", () => {
    const withGap = text(
      <SeoPerformanceSections
        report={{ field: okField, delivery_gap: diverged } as SeoPerformanceReport}
      />,
    );
    expect(withGap).toContain("The lab test and real visitors disagree");
    expect(withGap.indexOf("Largest paint")).toBeLessThan(
      withGap.indexOf("The lab test and real visitors disagree"),
    );

    const withoutGap = text(
      <SeoPerformanceSections report={{ field: okField } as SeoPerformanceReport} />,
    );
    expect(withoutGap).not.toContain("The lab test and real visitors disagree");
  });
});

describe("the score row stops fighting the headline above it", () => {
  const scored: LabCategory[] = [
    { id: "performance", title: "Performance", score: 0.37 },
    { id: "accessibility", title: "Accessibility", score: 0.91 },
    { id: "best-practices", title: "Best Practices", score: 1 },
    { id: "seo", title: "SEO", score: 0.92 },
  ];

  it("GIVES THE SCORES A UNIT — '37' out of nothing is not a number", () => {
    const out = text(<CategoryDials categories={scored} />);
    expect(out).toContain("Google scores each of these out of 100");
  });

  it("says the four marks grade different things", () => {
    const out = text(<CategoryDials categories={scored} />);
    expect(out).toContain("score 100 for best practice and still be slow");
  });

  it("SAYS 'poor' WHERE THE EYE IS, not only in the screen-reader line", () => {
    const out = html(<CategoryDials categories={scored} />);
    expect(out).toContain(">poor</p>");
    expect(out).toContain(">good</p>");
    expect(text(<CategoryDials categories={scored} />)).toContain("Speed: 37 out of 100, poor");
  });

  it("prints no band word for a category Google did not score", () => {
    const unscored: LabCategory[] = [{ id: "seo", score: null }];
    expect(html(<CategoryDials categories={unscored} />)).not.toContain(">poor</p>");
    expect(html(<CategoryDials categories={unscored} />)).not.toContain(">good</p>");
    expect(text(<CategoryDials categories={unscored} />)).toContain("not scored");
  });
});

describe("the Zavi's-own-check chip carries its reason", () => {
  const readiness = {
    checks: [{ id: "ai_crawlers", label: "Lets AI crawlers in", state: "pass" as const }],
    passed: 1,
    applicable: 1,
  };

  it("gives the disclaimer a REASON, right beside the chip", () => {
    const out = text(<AgentReadiness readiness={readiness} />);
    expect(out).toContain("Zavi's own check");
    expect(out).toContain("Google has no standard for this yet, so this is our own test.");
    expect(out.indexOf("Google has no standard for this yet")).toBeLessThan(
      out.indexOf("Lets AI crawlers in"),
    );
  });
});
