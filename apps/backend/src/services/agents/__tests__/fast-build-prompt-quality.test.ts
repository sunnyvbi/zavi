import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, calls: [] as Array<[string, string]> }));
vi.mock("@/services/settings", () => ({
  getNumberSetting: vi.fn(async () => 60),
  getBoolSetting: vi.fn(async (key: string, tenant: string) => {
    settings.calls.push([key, tenant]);
    const v = settings.values[key];
    if (v instanceof Error) throw v;
    return v;
  }),
}));

import { BOOKING_TIMES_RULE, fastSiteBuildPrompt, fastSiteEditPrompt, resolveFastSiteQualityRules } from "../fast-build-prompt";

const BASE = { companyName: "Paws & Suds", targetRepo: "praxis-built/paws-1", idea: "A dog grooming booking site" };
const REF = "https://wmyc.supabase.co/storage/v1/object/sign/agent-chat-images/t/ref.jpg?token=abc";
const ALL = { mobileWidth: true, siteMeta: true, downloadImages: true };

function rulesAfter8(prompt: string): string[] {
  const tail = prompt.slice(prompt.indexOf("8. Your step budget is small"));
  return tail.split("\n").slice(1);
}

beforeEach(() => {
  settings.values = {};
  settings.calls = [];
});

describe("fast site build prompt: quality rules", () => {
  it("with every rule on, adds numbered rules 9 and 10 for phone width and the site's identity", () => {
    const p = fastSiteBuildPrompt({ ...BASE, quality: ALL });
    const extra = rulesAfter8(p);
    expect(extra).toHaveLength(2);
    expect(extra[0]).toMatch(/^9\. /);
    expect(extra[0]).toContain("375px");
    expect(extra[0]).toContain("overflow-x: clip");
    expect(extra[1]).toMatch(/^10\. /);
    for (const token of ["<title>", "og:title", "og:description", "og:type", "og:url", "twitter:card", "public/favicon.svg", "src/pages/NotFound.tsx", '"New site"']) {
      expect(extra[1]).toContain(token);
    }
  });

  it("numbers the identity rule 9 when the width rule is off", () => {
    const extra = rulesAfter8(fastSiteBuildPrompt({ ...BASE, quality: { siteMeta: true } }));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/^9\. Give the site its identity/);
  });

  it("asks for the booking smoke journey only when its rule is enabled", () => {
    const prompt = fastSiteBuildPrompt({ ...BASE, quality: { bookingJourney: true } });
    expect(rulesAfter8(prompt)).toHaveLength(1);
    expect(prompt).toContain('name that smoke journey `book`');
    expect(prompt).toContain('"writes": true');
    expect(rulesAfter8(prompt)[0]).toContain(BOOKING_TIMES_RULE);
    const off = fastSiteBuildPrompt({ ...BASE, quality: { bookingJourney: false } });
    expect(off).not.toContain('name that smoke journey `book`');
    expect(off).not.toContain(BOOKING_TIMES_RULE);
  });

  it("with no rules on, the prompt ends at rule 8 exactly as before", () => {
    const off = fastSiteBuildPrompt({ ...BASE, referenceUrls: [REF] });
    expect(off.trimEnd().endsWith("8. Your step budget is small: a working core journey beats breadth.")).toBe(true);
    expect(off).not.toContain("public/reference/");
    expect(fastSiteBuildPrompt({ ...BASE, quality: {} })).toBe(fastSiteBuildPrompt(BASE));
  });

  it("tells the builder to download reference images into the repo, outside the untrusted block", () => {
    const p = fastSiteBuildPrompt({ ...BASE, referenceUrls: [REF], quality: ALL });
    const refs = p.slice(p.indexOf("### Founder's reference images"));
    const rule = refs.indexOf("public/reference/<name>.jpg");
    const block = refs.indexOf("<untrusted_reference_images>");
    expect(rule).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(rule);
    expect(refs).toContain("Never put a signed link in the code");
    expect(refs).toContain("7 days");
  });

  it("adds no download rule when there are no reference images", () => {
    const p = fastSiteBuildPrompt({ ...BASE, quality: ALL });
    expect(p).not.toContain("### Founder's reference images");
    expect(p).not.toContain("public/reference/");
  });

  it("the fast edit prompt is untouched by these rules", () => {
    const edit = fastSiteEditPrompt({ targetRepo: BASE.targetRepo, request: "make the button red" });
    expect(edit).not.toContain("375px");
    expect(edit).not.toContain("og:title");
  });
});

describe("resolveFastSiteQualityRules", () => {
  it("reads the four per-tenant keys for the run's tenant", async () => {
    settings.values = { site_no_sideways_scroll: true, site_meta_and_404: false, site_images_downloaded: true, site_booking_journey_required: true };
    expect(await resolveFastSiteQualityRules("t-1")).toEqual({ mobileWidth: true, siteMeta: false, downloadImages: true, bookingJourney: true });
    expect(settings.calls.sort()).toEqual([
      ["site_booking_journey_required", "t-1"],
      ["site_images_downloaded", "t-1"],
      ["site_meta_and_404", "t-1"],
      ["site_no_sideways_scroll", "t-1"],
    ]);
  });

  it("a key that cannot be read leaves only that rule off", async () => {
    settings.values = { site_no_sideways_scroll: new Error("db down"), site_meta_and_404: true, site_images_downloaded: true };
    expect(await resolveFastSiteQualityRules("t-1")).toEqual({ mobileWidth: false, siteMeta: true, downloadImages: true, bookingJourney: false });
  });
});
