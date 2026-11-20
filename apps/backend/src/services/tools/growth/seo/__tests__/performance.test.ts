
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../pagespeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pagespeed")>();
  return { ...actual, fetchPagespeed: vi.fn() };
});
vi.mock("../crux", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../crux")>();
  return { ...actual, fetchCrux: vi.fn() };
});

import { fetchPagespeed, type PagespeedReport } from "../pagespeed";
import { fetchCrux, type CruxResult } from "../crux";
import { GOOGLE_PAGESPEED_API_KEY_ENV } from "../google-api";
import {
  fetchSeoPerformance,
  SEO_PERFORMANCE_BUDGET_MS,
  SEO_PERFORMANCE_CONCURRENCY,
  SEO_PERFORMANCE_MAX_PAGES,
} from "../performance";

const psi = vi.mocked(fetchPagespeed);
const crux = vi.mocked(fetchCrux);

const SIX = [
  "https://example.com/",
  "https://example.com/pricing",
  "https://example.com/about",
  "https://example.com/blog",
  "https://example.com/features",
  "https://example.com/contact",
];

function report(url: string): PagespeedReport {
  return {
    kind: "ok",
    requested_url: url,
    strategy: "mobile",
    final_url: url,
    fetch_time: "2026-09-14T10:00:00.000Z",
    lighthouse_version: "13.3.0",
    categories: [],
    agentic_browsing: null,
    opportunities: [],
    server_response_ms: null,
  };
}

function cruxOk(): CruxResult {
  return {
    kind: "ok",
    scope: "origin",
    key: "https://example.com",
    collection_period: { first_date: "2026-08-17", last_date: "2026-09-13" },
    metrics: {
      largest_contentful_paint: { p75: 2400, histogram: [] },
      interaction_to_next_paint: null,
      cumulative_layout_shift: { p75: 0.05, histogram: [] },
      first_contentful_paint: null,
      experimental_time_to_first_byte: null,
    },
  };
}

let hadKey: string | undefined;

beforeEach(() => {
  hadKey = process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
  process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = "test-key-do-not-log";
  psi.mockReset();
  crux.mockReset();
  psi.mockImplementation(async (url: string) => report(url));
  crux.mockImplementation(async () => cruxOk());
});

afterEach(() => {
  vi.useRealTimers();
  if (hadKey === undefined) delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
  else process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = hadKey;
});

describe("no API key", () => {
  it("returns not_configured on BOTH halves without touching the network", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    const fetchSpy = vi.fn(async () => {
      throw new Error("the short-circuit leaked a request");
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const r = await fetchSeoPerformance(SIX);

      expect(r.field).toEqual({ state: "not_configured" });
      expect(r.lab).toEqual({ state: "not_configured" });
      expect(psi).not.toHaveBeenCalled();
      expect(crux).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("still stamps a fetched_at so the panel can date the answer", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    const r = await fetchSeoPerformance(SIX);
    expect(Number.isNaN(Date.parse(r.fetched_at))).toBe(false);
  });
});

describe("CrUX no_data", () => {
  it("flows through as no_data, NOT as an error", async () => {
    crux.mockImplementation(async () => ({ kind: "no_data", tried: ["url", "origin"] }));
    const r = await fetchSeoPerformance(SIX);

    expect(r.field.state).toBe("no_data");
    expect(r.field).toEqual({ state: "no_data", tried: ["url", "origin"] });
  });

  it("leaves the lab half completely alone", async () => {
    crux.mockImplementation(async () => ({ kind: "no_data", tried: ["url", "origin"] }));
    const r = await fetchSeoPerformance(SIX);

    expect(r.lab.state).toBe("ok");
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages).toHaveLength(SEO_PERFORMANCE_MAX_PAGES);
    expect(r.lab.truncated).toBe(false);
  });

  it("does not invent a collection period when CrUX carried none", async () => {
    crux.mockImplementation(async () => {
      const ok = cruxOk();
      if (ok.kind !== "ok") throw new Error("unreachable");
      return { ...ok, collection_period: null };
    });
    const r = await fetchSeoPerformance(SIX);

    expect(r.field.state).toBe("ok");
    if (r.field.state !== "ok") throw new Error("unreachable");
    expect(r.field.collection_period).toEqual({ first_date: null, last_date: null });
  });
});

describe("page selection", () => {
  it("audits every page the crawler visited, up to six", async () => {
    const r = await fetchSeoPerformance([...SIX, "https://example.com/careers"]);

    expect(psi).toHaveBeenCalledTimes(SEO_PERFORMANCE_MAX_PAGES);
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages.map((p) => p.requested_url)).toEqual(SIX);
  });

  it("asks CrUX exactly once, about the homepage", async () => {
    await fetchSeoPerformance(SIX);
    expect(crux).toHaveBeenCalledTimes(1);
    expect(crux.mock.calls[0][0]).toBe("https://example.com/");
  });

  it("de-duplicates and drops anything that is not a URL", async () => {
    await fetchSeoPerformance([
      "https://example.com/",
      "https://example.com/",
      "not a url",
      "",
      "https://example.com/pricing",
    ]);
    expect(psi).toHaveBeenCalledTimes(2);
  });

  it("keeps the crawl's order even when PSI answers out of order", async () => {
    psi.mockImplementation(async (url: string) => {
      const delay = url.endsWith("/") ? 30 : 0;
      await new Promise((res) => setTimeout(res, delay));
      return report(url);
    });
    const r = await fetchSeoPerformance(SIX.slice(0, 3));
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages.map((p) => p.requested_url)).toEqual(SIX.slice(0, 3));
  });
});

describe("bounded concurrency", () => {
  it("never has more than two PSI calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    psi.mockImplementation(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return report(url);
    });

    await fetchSeoPerformance(SIX);

    expect(psi).toHaveBeenCalledTimes(6);
    expect(peak).toBe(SEO_PERFORMANCE_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("does not spin up more workers than there are pages", async () => {
    let peak = 0;
    let inFlight = 0;
    psi.mockImplementation(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return report(url);
    });

    await fetchSeoPerformance([SIX[0]]);
    expect(peak).toBe(1);
  });
});

describe("wall-clock budget", () => {
  const REAL_PSI_MS = 114_000;

  it("is budgeted for three waves at the measured per-call duration", async () => {
    expect(SEO_PERFORMANCE_BUDGET_MS).toBeGreaterThan(3 * REAL_PSI_MS);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    psi.mockImplementation(async (url: string) => {
      vi.advanceTimersByTime(REAL_PSI_MS);
      return report(url);
    });

    const r = await fetchSeoPerformance(SIX, { concurrency: 1 });

    expect(psi).toHaveBeenCalledTimes(3);
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages).toHaveLength(3);
    expect(r.lab.truncated).toBe(true);
  });

  it("stops starting pages once the budget is gone and says truncated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    psi.mockImplementation(async (url: string) => {
      vi.advanceTimersByTime(REAL_PSI_MS);
      return report(url);
    });

    const r = await fetchSeoPerformance(SIX, { budgetMs: 250_000, concurrency: 1 });

    expect(psi).toHaveBeenCalledTimes(2);
    expect(r.lab.state).toBe("ok");
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages).toHaveLength(2);
    expect(r.lab.truncated).toBe(true);
  });

  it("will not spend a shared-quota request on a slice too short to finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    psi.mockImplementation(async (url: string) => {
      vi.advanceTimersByTime(REAL_PSI_MS);
      return report(url);
    });

    const r = await fetchSeoPerformance(SIX, { budgetMs: 134_000, concurrency: 1 });

    expect(psi).toHaveBeenCalledTimes(1);
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.truncated).toBe(true);
  });

  it("a partial lab result is not an error — the field half is untouched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    psi.mockImplementation(async (url: string) => {
      vi.advanceTimersByTime(REAL_PSI_MS);
      return report(url);
    });

    const r = await fetchSeoPerformance(SIX, { budgetMs: 250_000, concurrency: 1 });
    expect(r.field.state).toBe("ok");
  });

  it("does not claim truncation when every page fitted", async () => {
    const r = await fetchSeoPerformance(SIX);
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.truncated).toBe(false);
  });
});

describe("unavailable mapping", () => {
  it("turns a 429 into one readable reason, not a raw kind", async () => {
    crux.mockImplementation(async () => ({ kind: "rate_limited", retry_after_seconds: 30 }));
    const r = await fetchSeoPerformance(SIX);

    expect(r.field.state).toBe("unavailable");
    if (r.field.state !== "unavailable") throw new Error("unreachable");
    expect(r.field.reason).toContain("30s");
  });

  it("keeps not_configured out of the unavailable bucket", async () => {
    crux.mockImplementation(async () => ({
      kind: "not_configured",
      env_var: GOOGLE_PAGESPEED_API_KEY_ENV,
    }));
    const r = await fetchSeoPerformance(SIX);
    expect(r.field).toEqual({ state: "not_configured" });
  });

  it("reports the lab half unavailable only when NOTHING came back", async () => {
    psi.mockImplementation(async () => ({ kind: "network_error", message: "ECONNRESET" }));
    const r = await fetchSeoPerformance(SIX);

    expect(r.lab.state).toBe("unavailable");
    if (r.lab.state !== "unavailable") throw new Error("unreachable");
    expect(r.lab.reason).toContain("ECONNRESET");
  });

  it("one good page beats five failures — the lab half stays ok", async () => {
    psi.mockImplementation(async (url: string) =>
      url === SIX[0] ? report(url) : { kind: "http_error", status: 500, message: "boom" },
    );
    const r = await fetchSeoPerformance(SIX);

    expect(r.lab.state).toBe("ok");
    if (r.lab.state !== "ok") throw new Error("unreachable");
    expect(r.lab.pages).toHaveLength(1);
    expect(r.lab.truncated).toBe(false);
  });

  it("never throws when the crawl handed over nothing", async () => {
    const r = await fetchSeoPerformance([]);
    expect(r.field.state).toBe("unavailable");
    expect(r.lab.state).toBe("unavailable");
    expect(psi).not.toHaveBeenCalled();
    expect(crux).not.toHaveBeenCalled();
  });
});
