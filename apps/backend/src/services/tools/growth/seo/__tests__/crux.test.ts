
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchCrux, CRUX_METRICS } from "../crux";
import { GOOGLE_PAGESPEED_API_KEY_ENV } from "../google-api";
import cruxUrlFixture from "./fixtures/crux-upcar-url.json";
import cruxOriginFixture from "./fixtures/crux-upcar-origin.json";

const KEY = "test-key-do-not-log";

const NOT_FOUND = {
  error: {
    code: 404,
    message: "chrome ux report data not found for the query",
    status: "NOT_FOUND",
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubSequence(...responses: Response[]) {
  let i = 0;
  const f = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
  vi.stubGlobal("fetch", f);
  return f;
}

function record(over: Record<string, unknown> = {}): unknown {
  return {
    record: {
      key: { url: "https://example.com/" },
      metrics: {
        largest_contentful_paint: {
          histogram: [
            { start: 0, end: 2500, density: 0.7 },
            { start: 2500, end: 4000, density: 0.2 },
            { start: 4000, density: 0.1 },
          ],
          percentiles: { p75: 2800 },
        },
        interaction_to_next_paint: {
          histogram: [{ start: 0, end: 200, density: 1 }],
          percentiles: { p75: 150 },
        },
        cumulative_layout_shift: {
          histogram: [
            { start: "0.00", end: "0.10", density: 0.85 },
            { start: "0.10", end: "0.25", density: 0.1 },
            { start: "0.25", density: 0.05 },
          ],
          percentiles: { p75: "0.08" },
        },
        first_contentful_paint: {
          histogram: [{ start: 0, end: 1800, density: 0.9 }],
          percentiles: { p75: 1200 },
        },
        experimental_time_to_first_byte: {
          histogram: [{ start: 0, end: 800, density: 0.8 }],
          percentiles: { p75: 600 },
        },
      },
      collectionPeriod: {
        firstDate: { year: 2026, month: 8, day: 17 },
        lastDate: { year: 2026, month: 9, day: 13 },
      },
      ...over,
    },
  };
}

beforeEach(() => {
  process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
});

describe("fetchCrux — the request", () => {
  it("POSTs { url } to records:queryRecord with the key on the query string", async () => {
    const f = stubSequence(json(record()));
    await fetchCrux("https://example.com/pricing");

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://chromeuxreport.googleapis.com/v1/records:queryRecord",
    );
    expect(parsed.searchParams.get("key")).toBe(KEY);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com/pricing" });
  });

  it("returns not_configured and makes NO call when the key is unset", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    const f = stubSequence(json(record()));

    const res = await fetchCrux("https://example.com/");

    expect(res).toEqual({ kind: "not_configured", env_var: GOOGLE_PAGESPEED_API_KEY_ENV });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fetchCrux — happy path", () => {
  it("returns p75 plus the histogram for every metric, and the collection window", async () => {
    stubSequence(json(record()));
    const res = await fetchCrux("https://example.com/");

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.scope).toBe("url");
    expect(res.key).toBe("https://example.com/");
    expect(res.collection_period).toEqual({ first_date: "2026-08-17", last_date: "2026-09-13" });

    for (const name of CRUX_METRICS) expect(res.metrics[name]).not.toBeNull();
    expect(res.metrics.largest_contentful_paint).toEqual({
      p75: 2800,
      histogram: [
        { start: 0, end: 2500, density: 0.7 },
        { start: 2500, end: 4000, density: 0.2 },
        { start: 4000, end: null, density: 0.1 },
      ],
    });
  });

  it("coerces CLS's string percentiles and bin edges to numbers", async () => {
    stubSequence(json(record()));
    const res = await fetchCrux("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.metrics.cumulative_layout_shift?.p75).toBe(0.08);
    expect(res.metrics.cumulative_layout_shift?.histogram[0]).toEqual({
      start: 0,
      end: 0.1,
      density: 0.85,
    });
  });

  it("nulls a metric the record does not carry, and keeps the rest", async () => {
    stubSequence(
      json(
        record({
          metrics: {
            largest_contentful_paint: { percentiles: { p75: 2000 }, histogram: [] },
          },
        }),
      ),
    );
    const res = await fetchCrux("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.metrics.largest_contentful_paint?.p75).toBe(2000);
    expect(res.metrics.interaction_to_next_paint).toBeNull();
    expect(res.metrics.experimental_time_to_first_byte).toBeNull();
  });
});

describe("fetchCrux — 404 is not an error", () => {
  it("falls back to { origin } when the page has no record, and labels the scope", async () => {
    const f = stubSequence(
      json(NOT_FOUND, 404),
      json(record({ key: { origin: "https://example.com" } })),
    );

    const res = await fetchCrux("https://example.com/pricing");

    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual(
      { origin: "https://example.com" },
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.scope).toBe("origin");
    expect(res.key).toBe("https://example.com");
  });

  it("returns no_data — never throws — when neither the page nor the origin is in the dataset", async () => {
    const f = stubSequence(json(NOT_FOUND, 404), json(NOT_FOUND, 404));

    const res = await fetchCrux("https://example.com/pricing");

    expect(f).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ kind: "no_data", tried: ["url", "origin"] });
  });

  it("treats ANY 404 from this endpoint as no_data, whatever the message says", async () => {
    stubSequence(json({ error: { code: 404, message: "something else" } }, 404));
    const res = await fetchCrux("https://example.com/");
    expect(res.kind).toBe("no_data");
  });

  it("does not attempt an origin fallback when the URL will not parse", async () => {
    const f = stubSequence(json(NOT_FOUND, 404));
    const res = await fetchCrux("not-a-url");
    expect(f).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ kind: "no_data", tried: ["url"] });
  });
});

describe("fetchCrux — failure states that actually happen", () => {
  it("maps 429 to rate_limited", async () => {
    stubSequence(new Response("quota", { status: 429, headers: { "retry-after": "12" } }));
    const res = await fetchCrux("https://example.com/");
    expect(res).toEqual({ kind: "rate_limited", retry_after_seconds: 12 });
  });

  it("surfaces a rate limit hit on the ORIGIN retry rather than calling it no_data", async () => {
    stubSequence(json(NOT_FOUND, 404), new Response("quota", { status: 429 }));
    const res = await fetchCrux("https://example.com/pricing");
    expect(res.kind).toBe("rate_limited");
  });

  it("maps a non-404 error to http_error", async () => {
    stubSequence(json({ error: { code: 403, message: "API key not valid" } }, 403));
    const res = await fetchCrux("https://example.com/");
    expect(res).toMatchObject({ kind: "http_error", status: 403, message: "API key not valid" });
  });

  it("degrades a non-JSON 200 rather than throwing", async () => {
    stubSequence(new Response("<html>nope</html>", { status: 200 }));
    const res = await fetchCrux("https://example.com/");
    expect(res.kind).toBe("malformed_response");
  });

  it("degrades a 200 whose record is the wrong shape", async () => {
    stubSequence(json({ record: { metrics: "not an object", key: 7 } }));
    const res = await fetchCrux("https://example.com/");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.metrics.largest_contentful_paint).toBeNull();
    expect(res.collection_period).toBeNull();
    expect(res.key).toBe("https://example.com/");
  });

  it("maps a transport failure to network_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("EAI_AGAIN");
      }),
    );
    const res = await fetchCrux("https://example.com/");
    expect(res).toMatchObject({ kind: "network_error" });
  });

  it("maps a hung request to timeout", async () => {
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
    const res = await fetchCrux("https://example.com/", { timeoutMs: 5 });
    expect(res).toEqual({ kind: "timeout", timeout_ms: 5 });
  });
});

describe("fetchCrux — the real www.upcar.ai capture", () => {
  it("reads the url-scoped record, coercing CLS's STRING p75 to a number", async () => {
    stubSequence(json(cruxUrlFixture));
    const res = await fetchCrux("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.scope).toBe("url");
    expect(res.key).toBe("https://www.upcar.ai/");
    expect(res.metrics.largest_contentful_paint?.p75).toBe(3416);
    expect(res.metrics.interaction_to_next_paint?.p75).toBe(329);
    expect(res.metrics.first_contentful_paint?.p75).toBe(2528);
    expect(res.metrics.experimental_time_to_first_byte?.p75).toBe(1727);
    expect(res.metrics.cumulative_layout_shift?.p75).toBe(0.33);
    expect(typeof res.metrics.cumulative_layout_shift?.p75).toBe("number");
  });

  it("coerces the CLS histogram's string bin EDGES too, not just the p75", async () => {
    stubSequence(json(cruxUrlFixture));
    const res = await fetchCrux("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.metrics.cumulative_layout_shift?.histogram).toEqual([
      { start: 0, end: 0.1, density: 0.2824 },
      { start: 0.1, end: 0.25, density: 0.251 },
      { start: 0.25, end: null, density: 0.4665 },
    ]);
  });

  it("IGNORES the six metrics we never asked for, including the one with no percentiles", async () => {
    expect(Object.keys((cruxUrlFixture as { record: { metrics: object } }).record.metrics).length)
      .toBeGreaterThan(CRUX_METRICS.length);

    stubSequence(json(cruxUrlFixture));
    const res = await fetchCrux("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(Object.keys(res.metrics).sort()).toEqual([...CRUX_METRICS].sort());
    expect(res.metrics).not.toHaveProperty("form_factors");
    expect(res.metrics).not.toHaveProperty("round_trip_time");
  });

  it("carries the real 28-day collection period so the panel can state it", async () => {
    stubSequence(json(cruxUrlFixture));
    const res = await fetchCrux("https://www.upcar.ai/");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.collection_period).toEqual({
      first_date: "2026-08-16",
      last_date: "2026-09-12",
    });
  });

  it("reads the origin-scoped record, which really does differ from the page", async () => {
    stubSequence(json(cruxOriginFixture));
    const res = await fetchCrux("https://www.upcar.ai/some-page-with-no-record");

    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.key).toBe("https://www.upcar.ai");
    expect(res.metrics.largest_contentful_paint?.p75).toBe(2688);
    expect(res.metrics.cumulative_layout_shift?.p75).toBe(0.25);
  });

  it("falls back url → origin and labels the scope honestly", async () => {
    stubSequence(json(NOT_FOUND, 404), json(cruxOriginFixture));
    const res = await fetchCrux("https://www.upcar.ai/pricing");

    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.scope).toBe("origin");
    expect(res.metrics.largest_contentful_paint?.p75).toBe(2688);
  });
});
