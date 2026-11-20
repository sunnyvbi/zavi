import { describe, expect, it } from "vitest";
import { computeWinLine, pickWinMetric, rateOf, winLineFrom, winLineText } from "../win-line";
import { localParts, visitorsFrom, visitorsReportBody } from "../ga";
import { campaignSlugFor, newSlugSuffix, sealVariants } from "@/services/email-cards/variants";

describe("win line", () => {
  it("metric: visitors when tagged and GA is connected, else clicks on a tool route, else none", () => {
    expect(pickWinMetric({ route: "sendgrid", tagged: true, gaConnected: true })).toBe("visitors");
    expect(pickWinMetric({ route: "zavi_list", tagged: true, gaConnected: true })).toBe("visitors");
    expect(pickWinMetric({ route: "mailchimp", tagged: true, gaConnected: false })).toBe("clicks");
    expect(pickWinMetric({ route: "klaviyo", tagged: false, gaConnected: true })).toBe("clicks");
    expect(pickWinMetric({ route: "zavi_list", tagged: true, gaConnected: false })).toBeNull();
  });

  it("median of the last 5, at least 3, newest first", () => {
    expect(winLineFrom("clicks", [0.01, 0.02])).toEqual({ metric: "clicks", threshold: null, basis: "first_sends", n_past: 2 });
    expect(winLineFrom("clicks", [0.01, 0.03, 0.02])).toEqual({ metric: "clicks", threshold: 0.02, basis: "median", n_past: 3 });
    expect(winLineFrom("visitors", [0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 0.9]).threshold).toBe(0.3);
    expect(winLineFrom(null, [0.1, 0.2, 0.3])).toEqual({ metric: null, threshold: null, basis: "no_signal", n_past: 0 });
  });

  it("rate per delivered; unknown when either side is missing", () => {
    expect(rateOf({ visitors: 5, delivered: 100 }, "visitors")).toBe(0.05);
    expect(rateOf({ visitors: null, delivered: 100 }, "visitors")).toBeNull();
    expect(rateOf({ clicks: 3, delivered: 0 }, "clicks")).toBeNull();
  });

  it("reads only past results of the same metric", async () => {
    const past = [
      { win_line: { metric: "clicks" }, d7: { clicks: 2, delivered: 100 } },
      { win_line: { metric: "visitors" }, d7: { clicks: 50, visitors: 9, delivered: 100 } },
      { win_line: { metric: "clicks" }, d7: { clicks: 4, delivered: 100 } },
      { win_line: { metric: "clicks" }, d7: { clicks: 6, delivered: 100 } },
    ];
    const w = await computeWinLine("t", { route: "mailchimp", listId: "L", tagged: false, gaConnected: false }, { pastResults: async () => past });
    expect(w).toEqual({ metric: "clicks", threshold: 0.04, basis: "median", n_past: 3 });
    expect((await computeWinLine("t", { route: "mailchimp", listId: null, tagged: false, gaConnected: false }, { pastResults: async () => past })).basis).toBe("first_sends");
  });

  it("words", () => {
    expect(winLineText({ metric: "visitors", threshold: 0.021, basis: "median", n_past: 5 })).toBe("2.1% of delivered visit your site");
    expect(winLineText({ metric: "clicks", threshold: 0.004, basis: "median", n_past: 5 })).toBe("0.40% of delivered click");
    expect(winLineText({ metric: "clicks", threshold: null, basis: "first_sends", n_past: 1 })).toBe("First send: sets your baseline");
    expect(winLineText({ metric: null, threshold: null, basis: "no_signal", n_past: 0 })).toBe("No click or visitor signal");
  });
});

describe("GA visitors report", () => {
  it("local date and hour in the property's zone", () => {
    expect(localParts(new Date("2026-10-12T03:30:00Z"), "America/Los_Angeles")).toEqual({ date: "2026-10-11", hour: 20 });
    expect(localParts(new Date("2026-10-12T03:30:00Z"), "UTC")).toEqual({ date: "2026-10-12", hour: 3 });
  });

  it("the email's tag, source and medium; from the send's start day through day 7; test hours before the send excluded", () => {
    const body = visitorsReportBody({
      slug: "spring-update-20261012-abcdefghij",
      startedAt: new Date("2026-10-12T15:10:00Z"),
      finishedAt: new Date("2026-10-12T15:40:00Z"),
      timeZone: "America/New_York",
    });
    expect(body.dateRanges).toEqual([{ startDate: "2026-10-12", endDate: "2026-10-19" }]);
    expect(body.metrics).toEqual([{ name: "totalUsers" }]);
    expect(body.dimensions).toBeUndefined();
    const ex = (body.dimensionFilter as { andGroup: { expressions: unknown[] } }).andGroup.expressions;
    expect(ex.slice(0, 3)).toEqual([
      { filter: { fieldName: "sessionCampaignName", stringFilter: { matchType: "EXACT", value: "spring-update-20261012-abcdefghij", caseSensitive: true } } },
      { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "email", caseSensitive: true } } },
      { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "zavi", caseSensitive: true } } },
    ]);
    const early = (ex[3] as { notExpression: { filter: { inListFilter: { values: string[] } } } }).notExpression.filter.inListFilter.values;
    expect(early[0]).toBe("2026101200");
    expect(early.at(-1)).toBe("2026101210");
    expect(early).toHaveLength(11);
  });

  it("a send that started at local midnight has no test hours to drop", () => {
    const body = visitorsReportBody({ slug: "x-20261012", startedAt: new Date("2026-10-12T00:05:00Z"), finishedAt: new Date("2026-10-12T00:05:00Z"), timeZone: "UTC" });
    expect((body.dimensionFilter as { andGroup: { expressions: unknown[] } }).andGroup.expressions).toHaveLength(3);
  });

  it("no row is a real zero; a row is the distinct count", () => {
    expect(visitorsFrom({})).toBe(0);
    expect(visitorsFrom({ rows: [{ metricValues: [{ value: "17" }] }] })).toBe(17);
  });
});

describe("tag suffix (F7)", () => {
  it("each sealing gets its own 10-character suffix, kept in the snapshot", () => {
    expect(newSlugSuffix()).toMatch(/^[a-z0-9]{10}$/);
    expect(newSlugSuffix()).not.toBe(newSlugSuffix());
    expect(campaignSlugFor("Spring update!", new Date("2026-10-12T00:00:00Z"), "abcdefghij")).toBe("spring-update-20261012-abcdefghij");
    expect(campaignSlugFor("Spring update!", new Date("2026-10-12T00:00:00Z"))).toBe("spring-update-20261012");
    const template = { logo_url: null, brand_color: "#112233", button_color: "#112233", font_key: "system", sign_off: "Thanks", postal_address: "1 Main St", show_cards: false };
    const content = { subject: "Spring update", preview_text: "", title: "Hello", paragraphs: ["Hi there"], button: { label: "Read", url: "https://brightloop.test/a" } };
    const a = sealVariants(template as never, [content as never], { route: "sendgrid", companyName: "Brightloop", ownHost: "brightloop.test" });
    const b = sealVariants(template as never, [content as never], { route: "sendgrid", companyName: "Brightloop", ownHost: "brightloop.test" });
    expect(a.template_snapshot.campaign_slug).toMatch(/^spring-update-\d{8}-[a-z0-9]{10}$/);
    expect(a.template_snapshot.campaign_slug).not.toBe(b.template_snapshot.campaign_slug);
    expect(a.variants[0].html).toContain(`utm_campaign=${a.template_snapshot.campaign_slug}`);
  });
});
