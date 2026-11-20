
import { describe, it, expect } from "vitest";

import {
  computeDeliveryGap,
  DELIVERY_GAP_THRESHOLD_MS,
  type SeoFieldState,
} from "../performance";
import type { PagespeedReport } from "../pagespeed";
import type { CruxMetricName } from "../crux";
import psiFixture from "./fixtures/psi-upcar-mobile.json";
import cruxUrlFixture from "./fixtures/crux-upcar-url.json";
import cruxOriginFixture from "./fixtures/crux-upcar-origin.json";

const LAB_MS = (
  psiFixture as unknown as {
    lighthouseResult: { audits: Record<string, { numericValue?: number }> };
  }
).lighthouseResult.audits["server-response-time"].numericValue as number;

function ttfbOf(fixture: unknown): number {
  const record = (fixture as { record: { metrics: Record<string, { percentiles: { p75: number } }> } })
    .record;
  return record.metrics.experimental_time_to_first_byte.percentiles.p75;
}

function labPage(serverResponseMs: number | null): PagespeedReport {
  return {
    kind: "ok",
    requested_url: "https://www.upcar.ai/",
    strategy: "mobile",
    final_url: "https://www.upcar.ai/",
    fetch_time: null,
    lighthouse_version: "13.4.1",
    categories: [],
    agentic_browsing: null,
    opportunities: [],
    server_response_ms: serverResponseMs,
  };
}

function field(p75: number | null, scope: "url" | "origin" = "url"): SeoFieldState {
  const metrics = {} as Record<CruxMetricName, { p75: number | null; histogram: [] } | null>;
  for (const m of [
    "largest_contentful_paint",
    "interaction_to_next_paint",
    "cumulative_layout_shift",
    "first_contentful_paint",
    "experimental_time_to_first_byte",
  ] as CruxMetricName[]) {
    metrics[m] = null;
  }
  if (p75 !== null) metrics.experimental_time_to_first_byte = { p75, histogram: [] };
  return {
    state: "ok",
    scope,
    key: scope === "url" ? "https://www.upcar.ai/" : "https://www.upcar.ai",
    collection_period: { first_date: "2026-08-17", last_date: "2026-09-13" },
    metrics,
  };
}

describe("computeDeliveryGap — the real capture", () => {
  it("catches a 23ms server sitting behind a 1727ms real-user wait", async () => {
    const fieldMs = ttfbOf(cruxUrlFixture);
    expect(LAB_MS).toBe(23);
    expect(fieldMs).toBe(1727);

    const gap = computeDeliveryGap(field(fieldMs), labPage(LAB_MS));
    expect(gap).not.toBeNull();
    expect(gap?.state).toBe("diverged");
    expect(gap?.lab_ms).toBe(23);
    expect(gap?.field_ms).toBe(1727);
    expect(gap?.field_scope).toBe("url");
    expect(gap?.note).toContain("23 ms");
    expect(gap?.note).toContain("1727 ms");
  });

  it("still diverges on the origin-scoped record, and says whose number it is", async () => {
    const originMs = ttfbOf(cruxOriginFixture);
    expect(originMs).toBe(1016);

    const gap = computeDeliveryGap(field(originMs, "origin"), labPage(LAB_MS));
    expect(gap?.state).toBe("diverged");
    expect(gap?.field_scope).toBe("origin");
    expect(gap?.note).toContain("across your site");
    expect(gap?.note).not.toContain("to this page");
  });
});

describe("computeDeliveryGap — what the note is allowed to say", () => {
  it("never asserts a cause, and never computes a share of anything", async () => {
    const gap = computeDeliveryGap(field(1727), labPage(23));
    const note = gap?.note ?? "";

    expect(note).toContain("in front of the application, not inside it");
    expect(note).toContain("what to check");

    for (const causal of [
      "because",
      "caused by",
      "due to",
      "is your CDN",
      "your redirects are",
    ]) {
      expect(note.toLowerCase()).not.toContain(causal);
    }

    expect(note).not.toMatch(/\d+\s?%/);
    expect(note.toLowerCase()).not.toContain("of your lcp");
  });

  it("says the two AGREE rather than going silent when they do", async () => {
    const gap = computeDeliveryGap(field(300), labPage(250));
    expect(gap?.state).toBe("aligned");
    expect(gap?.note).toContain("The two agree");
    expect(gap?.note).toContain("not where the delay is");
  });
});

describe("computeDeliveryGap — the threshold, and the refusals", () => {
  it("speaks at exactly the threshold and stays quiet just under it", async () => {
    const lab = 100;
    expect(computeDeliveryGap(field(lab + DELIVERY_GAP_THRESHOLD_MS), labPage(lab))?.state).toBe(
      "diverged",
    );
    expect(
      computeDeliveryGap(field(lab + DELIVERY_GAP_THRESHOLD_MS - 1), labPage(lab))?.state,
    ).toBe("aligned");
  });

  it("uses Google's own published good-TTFB boundary as that threshold", async () => {
    expect(DELIVERY_GAP_THRESHOLD_MS).toBe(800);
  });

  it("is null when either half is missing — never a guess", async () => {
    expect(computeDeliveryGap(field(1727), null)).toBeNull();
    expect(computeDeliveryGap(field(1727), labPage(null))).toBeNull();
    expect(computeDeliveryGap(field(null), labPage(23))).toBeNull();
    expect(computeDeliveryGap({ state: "no_data", tried: ["url", "origin"] }, labPage(23))).toBeNull();
    expect(computeDeliveryGap({ state: "not_configured" }, labPage(23))).toBeNull();
    expect(
      computeDeliveryGap({ state: "unavailable", reason: "Google refused." }, labPage(23)),
    ).toBeNull();
  });

  it("does not flip sign when the field number is FASTER than the lab", async () => {
    const gap = computeDeliveryGap(field(120), labPage(900));
    expect(gap?.state).toBe("aligned");
    expect(gap?.lab_ms).toBe(900);
    expect(gap?.field_ms).toBe(120);
  });
});
