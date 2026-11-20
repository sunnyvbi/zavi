
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  fetchPagespeed,
  rankOpportunities,
  AGENTIC_BROWSING_CATEGORY_ID,
  MAX_OPPORTUNITIES,
  type PsiMetricName,
  type PsiCulprit,
} from "../pagespeed";
import { GOOGLE_PAGESPEED_API_KEY_ENV } from "../google-api";
import psiFixture from "./fixtures/psi-upcar-mobile.json";

const KEY = "test-key-do-not-log";

function classicCategories(): Record<string, unknown> {
  return {
    performance: { id: "performance", title: "Performance", score: 0.42, auditRefs: [] },
    accessibility: { id: "accessibility", title: "Accessibility", score: 0.9, auditRefs: [] },
    "best-practices": { id: "best-practices", title: "Best Practices", score: 1, auditRefs: [] },
    seo: { id: "seo", title: "SEO", score: 0.83, auditRefs: [] },
  };
}

function lhr(over: Record<string, unknown> = {}): unknown {
  return {
    lighthouseResult: {
      lighthouseVersion: "13.3.0",
      finalUrl: "https://example.com/",
      fetchTime: "2026-09-14T10:00:00.000Z",
      categories: classicCategories(),
      audits: {},
      ...over,
    },
  };
}

function stub(response: Response | (() => Response)) {
  const f = vi.fn(async () => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", f);
  return f;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
});

describe("fetchPagespeed — the request", () => {
  it("sends url, strategy, and `category` REPEATED once per category", async () => {
    const f = stub(json(lhr()));
    await fetchPagespeed("https://example.com/");

    const called = new URL((f.mock.calls[0] as unknown as [string])[0]);
    expect(called.origin + called.pathname).toBe(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    expect(called.searchParams.get("url")).toBe("https://example.com/");
    expect(called.searchParams.get("strategy")).toBe("mobile");
    expect(called.searchParams.getAll("category")).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
    expect(called.searchParams.get("key")).toBe(KEY);
    expect(called.searchParams.getAll("category")).not.toContain("agentic-browsing");
  });

  it("returns not_configured and makes NO call when the key is unset", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    const f = stub(json(lhr()));

    const res = await fetchPagespeed("https://example.com/");

    expect(res).toEqual({ kind: "not_configured", env_var: GOOGLE_PAGESPEED_API_KEY_ENV });
    expect(f).not.toHaveBeenCalled();
  });

  it("treats a blank key as unset", async () => {
    process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = "   ";
    const f = stub(json(lhr()));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fetchPagespeed — happy path", () => {
  it("extracts every category generically, plus version/finalUrl/fetchTime", async () => {
    stub(json(lhr()));
    const res = await fetchPagespeed("https://example.com/");

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.lighthouse_version).toBe("13.3.0");
    expect(res.final_url).toBe("https://example.com/");
    expect(res.fetch_time).toBe("2026-09-14T10:00:00.000Z");
    expect(res.categories.map((c) => c.id)).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
    expect(res.categories[0]).toMatchObject({
      id: "performance",
      title: "Performance",
      score: 0.42,
      scoreDisplayMode: null,
      audits: null,
    });
  });

  it("falls back to finalDisplayedUrl when finalUrl is absent", async () => {
    stub(
      json(
        lhr({ finalUrl: undefined, finalDisplayedUrl: "https://example.com/home" }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind === "ok" && res.final_url).toBe("https://example.com/home");
  });

  it("surfaces a category PSI returns that we never asked for", async () => {
    stub(
      json(
        lhr({
          categories: { ...classicCategories(), pwa: { id: "pwa", title: "PWA", score: 0.5 } },
        }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind === "ok" && res.categories.map((c) => c.id)).toContain("pwa");
  });
});

describe("fetchPagespeed — agentic-browsing", () => {
  it("returns null when the category is absent, and that is not an error", async () => {
    stub(json(lhr()));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("ok");
    expect(res.kind === "ok" && res.agentic_browsing).toBeNull();
  });

  it("surfaces it with per-audit pass/fail when it IS present", async () => {
    const refs = [
      "agent-accessibility-tree",
      "webmcp-form-coverage",
      "webmcp-registered-tools",
      "webmcp-schema-validity",
      "cumulative-layout-shift",
      "llms-txt",
    ];
    stub(
      json(
        lhr({
          categories: {
            ...classicCategories(),
            [AGENTIC_BROWSING_CATEGORY_ID]: {
              id: AGENTIC_BROWSING_CATEGORY_ID,
              title: "Agentic Browsing",
              score: 0.5,
              categoryScoreDisplayMode: "fraction",
              auditRefs: refs.map((id) => ({ id, weight: 1 })),
            },
          },
          audits: {
            "agent-accessibility-tree": { id: "agent-accessibility-tree", title: "Tree", score: 1 },
            "webmcp-form-coverage": { id: "webmcp-form-coverage", title: "Forms", score: 0 },
            "webmcp-registered-tools": {
              id: "webmcp-registered-tools",
              title: "Tools",
              score: null,
              scoreDisplayMode: "notApplicable",
            },
            "webmcp-schema-validity": {
              id: "webmcp-schema-validity",
              title: "Schema",
              score: null,
              scoreDisplayMode: "informative",
            },
            "cumulative-layout-shift": { id: "cumulative-layout-shift", title: "CLS", score: 1 },
          },
        }),
      ),
    );

    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const ab = res.agentic_browsing;
    expect(ab).not.toBeNull();
    expect(ab?.scoreDisplayMode).toBe("fraction");
    expect(ab?.score).toBe(0.5);
    expect(ab?.audits?.map((a) => [a.id, a.status])).toEqual([
      ["agent-accessibility-tree", "pass"],
      ["webmcp-form-coverage", "fail"],
      ["webmcp-registered-tools", "not_applicable"],
      ["webmcp-schema-validity", "unknown"],
      ["cumulative-layout-shift", "pass"],
      ["llms-txt", "unknown"],
    ]);
  });

  it("reads a plain `scoreDisplayMode` on the category too", async () => {
    stub(
      json(
        lhr({
          categories: {
            [AGENTIC_BROWSING_CATEGORY_ID]: {
              id: AGENTIC_BROWSING_CATEGORY_ID,
              title: "Agentic Browsing",
              score: 0.33,
              scoreDisplayMode: "fraction",
              auditRefs: [{ id: "llms-txt" }],
            },
          },
          audits: { "llms-txt": { id: "llms-txt", title: "llms.txt", score: 0 } },
        }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind === "ok" && res.agentic_browsing?.audits?.length).toBe(1);
  });
});

describe("fetchPagespeed — opportunities", () => {
  it("ranks legacy-only audits by savingsMs desc and caps the list", async () => {
    const audits: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      audits[`op-${i}`] = {
        id: `op-${i}`,
        title: `Opportunity ${i}`,
        score: 0,
        details: { overallSavingsMs: (i + 1) * 100 },
      };
    }
    audits["zero"] = { id: "zero", score: 0, details: { overallSavingsMs: 0 } };
    audits["plain"] = { id: "plain", title: "Just an audit", score: 1 };
    audits["scoreless"] = { id: "scoreless", details: { overallSavingsMs: 5000 } };

    stub(json(lhr({ audits })));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.opportunities).toHaveLength(MAX_OPPORTUNITIES);
    expect(res.opportunities[0]).toMatchObject({ id: "op-11", savingsMs: 1200 });
    expect(res.opportunities.map((o) => o.id)).not.toContain("zero");
    expect(res.opportunities.map((o) => o.id)).not.toContain("plain");
    expect(res.opportunities.map((o) => o.id)).not.toContain("scoreless");
  });

  it("keeps an opportunity that only has overallSavingsBytes", async () => {
    stub(
      json(
        lhr({
          audits: {
            "uses-webp": {
              id: "uses-webp",
              title: "Serve images in next-gen formats",
              score: 0,
              details: { overallSavingsBytes: 120_000 },
            },
            "render-block": {
              id: "render-block",
              title: "Eliminate render-blocking resources",
              score: 0,
              details: { overallSavingsMs: 300 },
            },
          },
        }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.opportunities.map((o) => o.id)).toEqual(["render-block", "uses-webp"]);
    expect(res.opportunities[1]).toEqual({
      id: "uses-webp",
      title: "Serve images in next-gen formats",
      score: 0,
      metricSavings: [],
      savingsMs: null,
      savingsBytes: 120_000,
      culprits: [],
    });
  });
});

describe("fetchPagespeed — failure states that actually happen", () => {
  it("maps 429 to rate_limited and reads Retry-After", async () => {
    stub(new Response("quota", { status: 429, headers: { "retry-after": "30" } }));
    const res = await fetchPagespeed("https://example.com/");
    expect(res).toEqual({ kind: "rate_limited", retry_after_seconds: 30 });
  });

  it("maps 429 without a usable Retry-After to a null wait", async () => {
    stub(new Response("quota", { status: 429 }));
    const res = await fetchPagespeed("https://example.com/");
    expect(res).toEqual({ kind: "rate_limited", retry_after_seconds: null });
  });

  it("maps other non-2xx to http_error with Google's message", async () => {
    stub(
      json({ error: { code: 400, message: "Unable to process request. URL is invalid." } }, 400),
    );
    const res = await fetchPagespeed("https://not-a-url");
    expect(res).toMatchObject({
      kind: "http_error",
      status: 400,
      message: "Unable to process request. URL is invalid.",
    });
  });

  it("never lets the key escape in an error message", async () => {
    stub(json({ error: { message: `bad key ${KEY} rejected` } }, 403));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("http_error");
    if (res.kind !== "http_error") return;
    expect(res.message).not.toContain(KEY);
    expect(res.message).toContain("[redacted]");
  });

  it("degrades a non-JSON 200 rather than throwing", async () => {
    stub(new Response("<html>gateway</html>", { status: 200 }));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("malformed_response");
  });

  it("degrades a 200 with no lighthouseResult", async () => {
    stub(json({ kind: "pagespeedonline#result" }));
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("malformed_response");
  });

  it("survives a categories map whose entries are the wrong type", async () => {
    stub(
      json(
        lhr({
          categories: { performance: "not an object", seo: { id: "seo", score: 0.5 } },
          audits: {
            broken: 42,
            ok: { id: "ok", score: 0, details: { overallSavingsMs: 10 } },
          },
        }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.categories.map((c) => c.id).sort()).toEqual(["performance", "seo"]);
    expect(res.opportunities.map((o) => o.id)).toEqual(["ok"]);
  });

  it("maps a transport failure to network_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const res = await fetchPagespeed("https://example.com/");
    expect(res).toMatchObject({ kind: "network_error" });
  });

  it("maps a slow PSI to timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const res = await fetchPagespeed("https://example.com/", { timeoutMs: 5 });
    expect(res).toEqual({ kind: "timeout", timeout_ms: 5 });
  });
});

describe("fetchPagespeed — the real www.upcar.ai capture", () => {
  it("reads Lighthouse 13.4.1 and exactly four categories, scored 0-1", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.lighthouse_version).toBe("13.4.1");
    expect(res.categories.map((c) => c.id)).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
    expect(res.categories.map((c) => c.score)).toEqual([0.42, 0.91, 1, 0.92]);
    for (const c of res.categories) {
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });

  it("finds NO scoreDisplayMode on any category, and does not invent one", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.categories.map((c) => c.scoreDisplayMode)).toEqual([null, null, null, null]);
    expect(res.categories.map((c) => c.audits)).toEqual([null, null, null, null]);
  });

  it("TRIPWIRE: agentic-browsing is not returned, so agentic_browsing is null", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.agentic_browsing).toBeNull();
    expect(res.categories.find((c) => c.id === AGENTIC_BROWSING_CATEGORY_ID)).toBeUndefined();
  });

  it("builds the fix list from metricSavings, in measured-impact order", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.opportunities.map((o) => o.id)).toEqual([
      "mainthread-work-breakdown",
      "layout-shifts",
      "render-blocking-insight",
      "image-delivery-insight",
      "cache-insight",
      "unused-css-rules",
      "unused-javascript",
    ]);
  });

  it("surfaces CLS, the one vital in the red, ABOVE the 414KB JavaScript audit", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    const ids = res.opportunities.map((o) => o.id);
    expect(ids.indexOf("layout-shifts")).toBeLessThan(ids.indexOf("unused-javascript"));

    const cls = res.opportunities.find((o) => o.id === "layout-shifts");
    expect(cls?.metricSavings).toEqual([{ metric: "CLS", value: 0.318, unit: "score" }]);
  });

  it("NEVER lists long-tasks — it reports TBT 1150ms and a score of 1", async () => {
    const raw = (psiFixture as unknown as { lighthouseResult: { audits: Record<string, {
      score: number; metricSavings?: Record<string, number> }> } }).lighthouseResult.audits;
    expect(raw["long-tasks"].score).toBe(1);
    expect(raw["long-tasks"].metricSavings?.TBT).toBe(1150);

    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.opportunities.map((o) => o.id)).not.toContain("long-tasks");
    for (const o of res.opportunities) expect(o.score).toBeLessThan(1);
  });

  it("shows ONE main-thread row, not three saying the same thing", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    const ids = res.opportunities.map((o) => o.id);
    expect(ids).toContain("mainthread-work-breakdown");
    expect(ids).not.toContain("bootup-time");
    expect(ids).not.toContain("long-tasks");
  });

  it("skips failing audits that quantify nothing", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.opportunities.map((o) => o.id)).not.toContain("duplicated-javascript-insight");
    expect(res.opportunities.map((o) => o.id)).not.toContain("legacy-javascript-insight");
  });

  it("keeps the 414KB as supporting detail on the row it belongs to", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    const js = res.opportunities.find((o) => o.id === "unused-javascript");
    expect(js).toMatchObject({ metricSavings: [], savingsMs: null, savingsBytes: 413973 });

    const css = res.opportunities.find((o) => o.id === "unused-css-rules");
    expect(css?.savingsBytes).toBe(39032);
    expect(css?.metricSavings).toEqual([
      { metric: "FCP", value: 250, unit: "ms" },
      { metric: "LCP", value: 150, unit: "ms" },
    ]);
  });

  it("keeps the redirect-adjusted final URL", async () => {
    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.requested_url).toBe("https://www.upcar.ai/");
    expect(res.final_url).toBe("https://www.upcar.ai/");
    expect(res.fetch_time).toBe("2026-09-14T23:38:24.910Z");
  });

  it("does NOT read loadingExperience, which the real response still carries", async () => {
    const raw = psiFixture as unknown as { loadingExperience?: unknown };
    expect(raw.loadingExperience).toBeDefined();

    stub(json(psiFixture));
    const res = await fetchPagespeed("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res).not.toHaveProperty("loading_experience");
    expect(JSON.stringify(res)).not.toContain("LARGEST_CONTENTFUL_PAINT_MS");
  });
});

describe("rankOpportunities — measured metric impact first, bytes below", () => {
  const metric = (m: PsiMetricName, value: number) => ({
    metric: m,
    value,
    unit: m === "CLS" ? ("score" as const) : ("ms" as const),
  });
  const op = (
    id: string,
    metricSavings: ReturnType<typeof metric>[],
    savingsMs: number | null = null,
    savingsBytes: number | null = null,
    culprits: PsiCulprit[] = [],
  ) => ({ id, title: id, score: 0, metricSavings, savingsMs, savingsBytes, culprits });

  it("compares metrics by share of their OWN good threshold, never by raw value", async () => {
    const ranked = rankOpportunities([
      op("lcp-big", [metric("LCP", 1100)]),
      op("cls-small-looking", [metric("CLS", 0.318)]),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(["cls-small-looking", "lcp-big"]);
  });

  it("scores a multi-metric opportunity on its STRONGEST metric, not the sum", async () => {
    const ranked = rankOpportunities([
      op("two-mediums", [metric("LCP", 900), metric("FCP", 900)]),
      op("one-strong", [metric("TBT", 300)]),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(["one-strong", "two-mediums"]);
  });

  it("puts every measured opportunity above every byte-only one", async () => {
    const ranked = rankOpportunities([
      op("huge-bytes", [], null, 9_000_000),
      op("tiny-measured", [metric("LCP", 10)]),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(["tiny-measured", "huge-bytes"]);
  });

  it("does NOT strand a pre-13 response that only has overallSavings*", async () => {
    const ranked = rankOpportunities([
      op("small", [], 100, 1_000),
      op("big", [], 4000, 10),
      op("bytes-only", [], null, 500_000),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(["big", "small", "bytes-only"]);
  });

  it("collapses the main-thread trio to its strongest row", async () => {
    const ranked = rankOpportunities([
      op("bootup-time", [metric("TBT", 1100)]),
      op("mainthread-work-breakdown", [metric("TBT", 1150)]),
      op("long-tasks", [metric("TBT", 1150)]),
      op("layout-shifts", [metric("CLS", 0.318)]),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(["mainthread-work-breakdown", "layout-shifts"]);
  });

  it("leaves a single member of an overlap group alone", async () => {
    const ranked = rankOpportunities([op("bootup-time", [metric("TBT", 1100)])]);
    expect(ranked.map((o) => o.id)).toEqual(["bootup-time"]);
  });

  it("survives truncation — the top measured win is never cut by MAX_OPPORTUNITIES", async () => {
    const many = Array.from({ length: MAX_OPPORTUNITIES + 4 }, (_, i) =>
      op(`bytes-${i}`, [], null, 1_000_000 - i),
    );
    const ranked = rankOpportunities([...many, op("measured", [metric("CLS", 0.4)])]);
    expect(ranked.slice(0, MAX_OPPORTUNITIES).map((o) => o.id)).toContain("measured");
    expect(ranked[0].id).toBe("measured");
  });

  it("returns every opportunity exactly once and is stable", async () => {
    const input = [
      op("a", [metric("LCP", 100)]),
      op("b", [], null, 200),
      op("c", [metric("TBT", 300)]),
    ];
    const ranked = rankOpportunities(input);
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((o) => o.id)).size).toBe(3);
    expect(rankOpportunities(input).map((o) => o.id)).toEqual(ranked.map((o) => o.id));
  });

  it("is a no-op on an empty list", async () => {
    expect(rankOpportunities([])).toEqual([]);
  });
});
