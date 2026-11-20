import { describe, it, expect } from "vitest";
import { pickFirstRun, runsOnPublicEvidence } from "../auto-first-run";

describe("runsOnPublicEvidence — can this channel see anything with nothing linked", () => {
  it("seo reads public evidence (growth_seo_audit)", () => {
    expect(runsOnPublicEvidence("seo")).toBe(true);
  });

  it("reddit_organic reads public evidence (reddit_thread_read)", () => {
    expect(runsOnPublicEvidence("reddit_organic")).toBe(true);
  });

  it("meta_ads does not — it needs the ad account", () => {
    expect(runsOnPublicEvidence("meta_ads")).toBe(false);
  });

  it("email_marketing does not, despite being cgo's second most-picked channel", () => {
    expect(runsOnPublicEvidence("email_marketing")).toBe(false);
  });

  it("a slug the registry does not carry is never runnable", () => {
    expect(runsOnPublicEvidence("not_a_channel")).toBe(false);
  });
});

describe("pickFirstRun — the plan's order, first one we can actually service", () => {
  it("takes the top bet when it can see something", () => {
    expect(
      pickFirstRun([{ channel_slug: "seo" }, { channel_slug: "meta_ads" }]),
    ).toBe("seo");
  });

  it("walks past a connector-gated top bet to one that reads public evidence", () => {
    expect(
      pickFirstRun([
        { channel_slug: "meta_ads" },
        { channel_slug: "email_marketing" },
        { channel_slug: "reddit_organic" },
      ]),
    ).toBe("reddit_organic");
  });

  it("falls back to the plan's TOP bet when nothing is publicly serviceable", () => {
    expect(
      pickFirstRun([{ channel_slug: "meta_ads" }, { channel_slug: "google_ads" }]),
    ).toBe("meta_ads");
  });

  it("no bets ⇒ no run", () => {
    expect(pickFirstRun([])).toBeNull();
  });

  it("returns ONE slug, never a list", () => {
    const picked = pickFirstRun([
      { channel_slug: "seo" },
      { channel_slug: "reddit_organic" },
    ]);
    expect(typeof picked).toBe("string");
    expect(picked).toBe("seo");
  });
});
