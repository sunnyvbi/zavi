import { describe, expect, it } from "vitest";
import { listingTargetsOf } from "../listing-targets";
import type { VisibilityMetrics } from "../metrics";

type Kind = "owned" | "rival" | "other";
const metrics = (
  domains: [string, number, Kind?][],
  rows: { prompt: string; rivalOnly: number; cited: string[] }[] = [],
  rivals: string[] = [],
): VisibilityMetrics =>
  ({
    share_of_voice: { rivals: rivals.map((name) => ({ name, mentions: 1, share: null })) },
    source_mix: { domains: domains.map(([domain, responses, kind]) => ({ domain, responses, kind: kind ?? "other", rival: null })) },
    prompt_grid: {
      rows: rows.map((r) => ({
        prompt_text: r.prompt,
        rival_only_responses: r.rivalOnly,
        cited_domains: r.cited.map((domain) => ({ domain, responses: 1, kind: "other", rival: null })),
      })),
    },
  }) as unknown as VisibilityMetrics;

describe("listingTargetsOf", () => {
  it("names the most-cited directory with its confirmed sign-up page", () => {
    const out = listingTargetsOf(
      metrics(
        [["nerdwallet.com", 37], ["g2.com", 12], ["producthunt.com", 3]],
        [
          { prompt: "alternatives to Turo for renting out my car", rivalOnly: 36, cited: ["g2.com", "nerdwallet.com"] },
          { prompt: "is car sharing safe", rivalOnly: 0, cited: ["g2.com"] },
        ],
      ),
    );
    expect(out.listing_target).toMatchObject({
      domain: "g2.com",
      name: "G2",
      responses: 12,
      way_in_url: "https://sell.g2.com/create-free-profile",
      prompts: ["alternatives to Turo for renting out my car"],
    });
    expect(out.listing_checked).toEqual([
      { domain: "nerdwallet.com", reason: "no_known_way_in" },
      { domain: "producthunt.com", reason: "another_directory" },
    ]);
  });

  it("matches a subdomain or www form of a directory", () => {
    expect(listingTargetsOf(metrics([["learn.g2.com", 3]])).listing_target?.name).toBe("G2");
    expect(listingTargetsOf(metrics([["www.joe.coffee", 20]])).listing_target?.way_in_url).toBe("https://joe.coffee/claim");
  });

  it("never targets a community thread, an app store page, a rival or the company's own site", () => {
    const out = listingTargetsOf(
      metrics([["reddit.com", 15], ["apps.apple.com", 17], ["g2.com", 9, "rival"], ["upcar.ai", 40, "owned"], ["ridester.com", 24]]),
    );
    expect(out.listing_target).toBeNull();
    expect(out.listing_checked).toEqual([
      { domain: "ridester.com", reason: "no_known_way_in" },
      { domain: "apps.apple.com", reason: "app_store" },
      { domain: "reddit.com", reason: "community" },
    ]);
  });

  it("sums one directory's hosts before ranking, and does not list its other host as checked", () => {
    const out = listingTargetsOf(metrics([["g2.com", 6], ["learn.g2.com", 6], ["producthunt.com", 7]]));
    expect(out.listing_target).toMatchObject({ name: "G2", responses: 12 });
    expect(out.listing_checked).toEqual([{ domain: "producthunt.com", reason: "another_directory" }]);
  });

  it("never sends the company to a directory it tracks as a rival", () => {
    const out = listingTargetsOf(metrics([["g2.com", 20], ["trustpilot.com", 3]], [], ["G2"]));
    expect(out.listing_target?.name).toBe("Trustpilot");
    for (const rival of ["g2", "G2.com", "www.g2.com"]) {
      expect(listingTargetsOf(metrics([["g2.com", 20], ["trustpilot.com", 3]], [], [rival])).listing_target?.name).toBe("Trustpilot");
    }
  });

  it("caps the checked list and says how many it left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => [`site${i}.com`, 12 - i] as [string, number]);
    const out = listingTargetsOf(metrics(many));
    expect(out.listing_checked).toHaveLength(8);
    expect(out.listing_checked_omitted).toBe(4);
  });

  it("says nothing when there is no sample", () => {
    expect(listingTargetsOf(null)).toEqual({ listing_target: null, listing_checked: [], listing_checked_omitted: 0 });
  });
});
