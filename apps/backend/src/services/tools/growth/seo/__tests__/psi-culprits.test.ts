
import { describe, it, expect } from "vitest";

import { extractCulprits, isTagHost, MAX_CULPRITS } from "../psi-culprits";
import psiFixture from "./fixtures/psi-upcar-mobile.json";

const audits = (psiFixture as { lighthouseResult: { audits: Record<string, any> } })
  .lighthouseResult.audits;

function itemsOf(id: string): unknown {
  const details = audits[id]?.details;
  return details?.items;
}

describe("extractCulprits — the rule", () => {
  it("names nothing when a row has neither a url nor a node", () => {
    const rows = itemsOf("mainthread-work-breakdown") as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.url === undefined && r.node === undefined)).toBe(true);
    expect(extractCulprits(rows)).toEqual([]);
  });

  it("returns [] for a missing or non-array details.items", () => {
    expect(extractCulprits(undefined)).toEqual([]);
    expect(extractCulprits(null)).toEqual([]);
    expect(extractCulprits({ type: "checklist" })).toEqual([]);
  });

  it("survives an unreadable row without losing the readable ones", () => {
    const out = extractCulprits([
      { url: 42, totalBytes: "nonsense" },
      null,
      { url: "not a url at all" },
      { url: "https://example.com/app.js", totalBytes: 1024 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("app.js");
  });

  it("caps the list and keeps the largest", () => {
    const rows = itemsOf("image-delivery-insight") as unknown[];
    expect(rows.length).toBe(31);
    const out = extractCulprits(rows);
    expect(out).toHaveLength(MAX_CULPRITS);
    const wasted = out.map((c) => c.wastedBytes ?? 0);
    expect([...wasted].sort((a, b) => b - a)).toEqual(wasted);
    expect(wasted[0]).toBeGreaterThan(128_000);
  });
});

describe("extractCulprits — naming the real culprits", () => {
  it("names the main-thread scripts bootup-time blamed", () => {
    const out = extractCulprits(itemsOf("bootup-time"));
    const labels = out.map((c) => c.label);
    expect(labels).toContain("60286-17829337074827a7.js");
    expect(labels).toContain("posthog-recorder.js");

    const chunk = out.find((c) => c.label === "60286-17829337074827a7.js");
    expect(chunk).toBeDefined();
    expect(chunk?.kind).toBe("script");
    expect(chunk?.owner).toBe("developer");
    expect(chunk?.detail).toContain("1,275 ms of main-thread time");
    expect(chunk?.detail).toContain("1,006 ms of it running JavaScript");

    expect(out.find((c) => c.label === "posthog-recorder.js")?.owner).toBe("developer");
  });

  it("names the element that moved the page", () => {
    const out = extractCulprits(itemsOf("layout-shifts"));
    expect(out[0].kind).toBe("element");
    expect(out[0].label).toBe("div.main-container");
    expect(out[0].owner).toBe("developer");
    expect(out[0].detail).toContain("Moved the page by 0.301 of layout shift");
  });

  it("writes a row's measurements as one sentence, not fragments split by full stops", () => {
    const out = extractCulprits([{ url: "https://example.com/app.css", totalBytes: 42803, wastedMs: 958 }]);
    expect(out[0].detail).toBe("41.8 KB, holds up the first render by 958 ms.");
  });

  it("follows an image proxy to the asset it is actually serving", () => {
    const out = extractCulprits(itemsOf("image-delivery-insight"));
    expect(out.every((c) => c.label !== "image")).toBe(true);
    expect(out[0].label).toMatch(/\.(?:avif|webp|png|jpe?g)$/i);
    expect(out[0].kind).toBe("image");
    expect(out[0].detail).toContain("displayed dimensions");
  });

  it("names the render-blocking stylesheet and what it costs", () => {
    const out = extractCulprits(itemsOf("render-blocking-insight"));
    expect(out[0].label).toBe("90e93c2cafffa7a4.css");
    expect(out[0].kind).toBe("stylesheet");
    expect(out[0].owner).toBe("developer");
    expect(out[0].detail).toContain("holds up the first render by 971 ms");
  });

  it("says why a cached asset is re-downloaded", () => {
    const out = extractCulprits(itemsOf("cache-insight"));
    expect(out.some((c) => c.detail.includes("no cache lifetime set"))).toBe(true);
  });
});

describe("owner — derived from the host, never guessed", () => {
  it("treats tag-console hosts as founder-fixable and everything else as developer", () => {
    expect(isTagHost("www.googletagmanager.com")).toBe(true);
    expect(isTagHost("region1.google-analytics.com")).toBe(true);
    expect(isTagHost("googletagmanager.com")).toBe(true);
    expect(isTagHost("cdn.jsdelivr.net")).toBe(false);
    expect(isTagHost("www.upcar.ai")).toBe(false);
  });

  it("falls back to developer rather than inventing a third state", () => {
    const out = extractCulprits([{ url: "https://weird.example/thing?x=1", totalBytes: 10 }]);
    expect(out[0].owner).toBe("developer");
    expect(out[0].kind).toBe("other");
  });
});

describe("the duplicate tag install", () => {
  it("folds the twice-loaded GA4 id into ONE founder-owned row", () => {
    const out = extractCulprits(itemsOf("unused-javascript"));

    const dup = out.filter((c) => c.label.includes("G-HM2Q35YQZX"));
    expect(dup).toHaveLength(1);
    expect(dup[0].owner).toBe("founder");
    expect(dup[0].kind).toBe("third_party");
    expect(dup[0].label).toBe("Google Analytics (GA4) G-HM2Q35YQZX");
    expect(dup[0].detail).toContain("Loaded twice on the same page");
    expect(dup[0].detail).toContain("once directly and once through a tag manager");
    expect(dup[0].bytes).toBe(389_321);
    expect(dup[0].wastedBytes).toBe(198_392);
    expect(dup[0].detail).toContain("190.1 KB each");
    expect(dup[0].detail).toContain("380.2 KB in total");

    expect(out.filter((c) => c.label === "js")).toHaveLength(0);
    expect(
      out.filter((c) => c.detail.includes("gtag/js?id=G-HM2Q35YQZX")),
    ).toHaveLength(0);
  });

  it("leaves a tag loaded ONCE alone, but still names the product", () => {
    const out = extractCulprits(itemsOf("unused-javascript"));
    const ads = out.find((c) => c.label === "Google Ads AW-17090274121");
    expect(ads).toBeDefined();
    expect(ads?.detail).not.toContain("Loaded twice");
    expect(ads?.owner).toBe("founder");

    const container = out.find((c) => c.label === "Google Tag Manager GTM-WDKQ4PHR");
    expect(container).toBeDefined();
    expect(container?.owner).toBe("founder");
    expect(out.map((c) => c.label)).not.toContain("gtm.js");
    expect(out.map((c) => c.label)).not.toContain("js");
  });

  it("does NOT call two unsigned requests a double install", () => {
    const out = extractCulprits([
      { url: "https://www.googletagmanager.com/gtag/js?id=G-AAA&r=1", totalBytes: 1000 },
      { url: "https://www.googletagmanager.com/gtag/js?id=G-AAA&r=2", totalBytes: 1000 },
    ]);
    expect(out.every((c) => !c.detail.includes("Loaded twice"))).toBe(true);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.owner === "founder")).toBe(true);
  });

  it("recognises the signature on either request", () => {
    const out = extractCulprits([
      { url: "https://www.googletagmanager.com/gtag/js?id=G-BBB", totalBytes: 1000 },
      { url: "https://www.googletagmanager.com/gtag/js?id=G-BBB&cx=c&gtm=4e69b1", totalBytes: 1500 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toBe(2500);
    expect(out[0].owner).toBe("founder");
  });

  it("names the product from Google's documented id prefixes", () => {
    const gtm = extractCulprits([
      { url: "https://www.googletagmanager.com/gtm.js?id=GTM-X", totalBytes: 1 },
      { url: "https://www.googletagmanager.com/gtm.js?id=GTM-X&gtm=1", totalBytes: 1 },
    ]);
    expect(gtm[0].label).toBe("Google Tag Manager GTM-X");

    const ads = extractCulprits([
      { url: "https://www.googletagmanager.com/gtag/js?id=AW-1", totalBytes: 1 },
      { url: "https://www.googletagmanager.com/gtag/js?id=AW-1&cx=c", totalBytes: 1 },
    ]);
    expect(ads[0].label).toBe("Google Ads AW-1");
  });
});
