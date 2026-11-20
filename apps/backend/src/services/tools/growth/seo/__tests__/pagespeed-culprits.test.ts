
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchPagespeed, MAX_CULPRITS } from "../pagespeed";
import { GOOGLE_PAGESPEED_API_KEY_ENV } from "../google-api";
import psiFixture from "./fixtures/psi-upcar-mobile.json";

const KEY = "test-key-do-not-log";

function stub(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  vi.stubEnv(GOOGLE_PAGESPEED_API_KEY_ENV, KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function report() {
  stub(psiFixture);
  const res = await fetchPagespeed("https://www.upcar.ai/");
  if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
  return res;
}

describe("fetchPagespeed — named culprits on the real capture", () => {
  it("hands every opportunity the rows Lighthouse blamed", async () => {
    const res = await report();

    for (const o of res.opportunities) {
      expect(o.culprits.length, `${o.id} has no culprits`).toBeGreaterThan(0);
      expect(o.culprits.length).toBeLessThanOrEqual(MAX_CULPRITS);
      for (const c of o.culprits) {
        expect(c.label.trim()).not.toBe("");
        expect(c.detail.trim()).not.toBe("");
        expect(["founder", "developer"]).toContain(c.owner);
      }
    }
  });

  it("the main-thread winner inherits bootup-time's per-file names", async () => {
    const res = await report();

    const ids = res.opportunities.map((o) => o.id);
    expect(ids).toContain("mainthread-work-breakdown");
    expect(ids).not.toContain("bootup-time");

    const main = res.opportunities.find((o) => o.id === "mainthread-work-breakdown");
    const labels = main?.culprits.map((c) => c.label) ?? [];
    expect(labels).toContain("60286-17829337074827a7.js");
    expect(labels).toContain("posthog-recorder.js");
    expect(main?.metricSavings).toEqual([{ metric: "TBT", value: 1150, unit: "ms" }]);
    expect(labels).not.toContain("Script Evaluation");
  });

  it("reports the GA4 double install as one founder-fixable row", async () => {
    const res = await report();

    const js = res.opportunities.find((o) => o.id === "unused-javascript");
    const dup = js?.culprits.find((c) => c.label.includes("G-HM2Q35YQZX"));
    expect(dup).toBeDefined();
    expect(dup?.owner).toBe("founder");
    expect(dup?.kind).toBe("third_party");
    expect(dup?.detail).toContain("Loaded twice on the same page");
    expect(js?.culprits.filter((c) => c.label.includes("G-HM2Q35YQZX"))).toHaveLength(1);
  });

  it("names the oversized images and the shifting container", async () => {
    const res = await report();

    const images = res.opportunities.find((o) => o.id === "image-delivery-insight");
    expect(images?.metricSavings).toEqual([{ metric: "LCP", value: 1100, unit: "ms" }]);
    expect(images?.culprits.every((c) => c.kind === "image")).toBe(true);
    expect(images?.culprits.every((c) => c.owner === "developer")).toBe(true);

    const shift = res.opportunities.find((o) => o.id === "layout-shifts");
    expect(shift?.culprits[0].label).toBe("div.main-container");
    expect(shift?.culprits[0].kind).toBe("element");
  });

  it("carries the PASSING server-response-time measurement out of the report", async () => {
    const res = await report();

    expect(res.server_response_ms).toBe(23);
    expect(res.opportunities.map((o) => o.id)).not.toContain("server-response-time");
  });

  it("MEASURED: font-display-insight PASSES here, so it is never a fix", async () => {
    const raw = psiFixture as unknown as {
      lighthouseResult: {
        audits: Record<string, { score: number; details?: { items?: unknown[] } }>;
      };
    };
    expect(raw.lighthouseResult.audits["font-display-insight"].score).toBe(1);
    expect(raw.lighthouseResult.audits["font-display-insight"].details?.items ?? []).toHaveLength(
      0,
    );
    for (const gone of [
      "font-display",
      "uses-responsive-images",
      "modern-image-formats",
      "uses-optimized-images",
    ]) {
      expect(raw.lighthouseResult.audits[gone]).toBeUndefined();
    }

    const res = await report();
    expect(res.opportunities.map((o) => o.id)).not.toContain("font-display-insight");
  });

  it("an opportunity with no details.items still ships, with an empty list", async () => {
    stub({
      lighthouseResult: {
        lighthouseVersion: "13.4.1",
        finalUrl: "https://example.com/",
        categories: {},
        audits: {
          "some-audit": {
            id: "some-audit",
            title: "Something",
            score: 0,
            metricSavings: { LCP: 900 },
          },
        },
      },
    });
    const res = await fetchPagespeed("https://example.com/");
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.opportunities[0].culprits).toEqual([]);
    expect(res.server_response_ms).toBeNull();
  });
});
