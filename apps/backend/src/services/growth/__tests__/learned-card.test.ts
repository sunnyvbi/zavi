import { describe, expect, it } from "vitest";
import { learnedCardOf } from "../learned-card";
import type { GrowthIntakeResearchRow } from "@/routes/workspace/growth-intake-research";

const page = (url: string) => ({ url, title: "t", text_excerpt: "x" });
const comp = (name: string) => ({ name, url: "", source_title: "", source_url: "", snippet: "" });
const fact = (over: Record<string, unknown>) => ({
  topic: "offering",
  fact: "They clean homes weekly across San Jose and nearby towns",
  own_site: true,
  quote: "Weekly home cleaning across San Jose",
  source_url: "https://sparkle.example/services",
  ...over,
});

function row(over: Partial<GrowthIntakeResearchRow> & { payload?: unknown } = {}): GrowthIntakeResearchRow {
  return {
    status: "ready",
    reason: null,
    fetched_at: "2026-10-30T00:00:00Z",
    payload: {
      domain: "sparkle.example",
      research_pages: [page("https://www.yelp.com/biz/sparkle"), page("https://yelp.com/x"), page("https://nextdoor.com/p")],
      competitors: [comp("Molly Maid"), comp("Merry Maids"), comp("molly maid"), comp("Two Maids")],
      site: null,
      marketplace: { intel: { secret: "liquidity 0.42" }, liquidity: null },
      dossier: {
        facts: [
          fact({}),
          fact({ topic: "reviews", quote: "Jane Doe from Willow Glen said they were great" }),
          fact({ topic: "pricing", quote: "Standard clean starts at $80", as_of: "2019" }),
          fact({ topic: "pricing", quote: "Deep cleans from $160 per visit", own_site: false }),
          fact({ topic: "locations", quote: "Serving Campbell &amp; Los Gatos too" }),
          fact({ topic: "customers", quote: "weekly HOME cleaning across san jose" }),
          fact({ topic: "differentiation", quote: "<script>alert(1)</script> eco products only" }),
          fact({ topic: "offering", quote: "Move-out cleans for renters" }),
        ],
        pages_read: [{ url: "https://sparkle.example/", title: "Home" }, { url: "https://sparkle.example/services", title: "S" }],
        dropped_unverified: 2,
        cost_usd: 0.1,
      },
    } as GrowthIntakeResearchRow["payload"],
    ...over,
  } as GrowthIntakeResearchRow;
}

describe("learnedCardOf (what Zavi learned, shown while the plan cooks)", () => {
  it("no row yet, a pending pass, or a failed pass shows nothing", () => {
    expect(learnedCardOf(null)).toEqual({ status: "none", card: null });
    expect(learnedCardOf(row({ status: "pending" }))).toEqual({ status: "pending", card: null });
    expect(learnedCardOf(row({ status: "failed", reason: "no_domain_on_file" }))).toEqual({ status: "failed", card: null });
  });

  it("names outside sources, two or more rivals once each, and the pages of their own site it read", () => {
    const { status, card } = learnedCardOf(row());
    expect(status).toBe("ready");
    expect(card!.lines).toEqual([
      "Read 3 pages about you outside your own site, on yelp.com and nextdoor.com.",
      "You come up next to Molly Maid, Merry Maids and Two Maids.",
      "Read 2 pages of your own site.",
    ]);
  });

  it("quotes only checked lines from their own site: no reviews, no dated or third-party lines, no duplicates, no markup", () => {
    const { card } = learnedCardOf(row());
    const texts = card!.quotes.map((q) => q.text);
    expect(texts).toEqual([
      "Weekly home cleaning across San Jose",
      "Serving Campbell & Los Gatos too",
      "Move-out cleans for renters",
    ]);
    expect(texts.join(" ")).not.toMatch(/Jane Doe|\$80|\$160|script|eco products/);
    expect(card!.quotes.every((q) => q.source_url === "https://sparkle.example/services")).toBe(true);
  });

  it("never shows the marketplace numbers or the model's own sentences", () => {
    const json = JSON.stringify(learnedCardOf(row()));
    expect(json).not.toContain("liquidity");
    expect(json).not.toContain("They clean homes weekly");
  });

  it("a thin pass never claims outside sources, and one rival alone is not named", () => {
    const thin = row({ status: "thin" });
    (thin.payload as { competitors: unknown[] }).competitors = [comp("Molly Maid")];
    const { status, card } = learnedCardOf(thin);
    expect(status).toBe("thin");
    expect(card!.lines).toEqual(["Read 2 pages of your own site."]);
    expect(card!.quotes.length).toBe(3);
  });

  it("a settled pass with nothing usable shows no card rather than an empty one", () => {
    const bare = row({ status: "thin" });
    Object.assign(bare.payload as object, { research_pages: [], competitors: [], dossier: null });
    expect(learnedCardOf(bare)).toEqual({ status: "thin", card: null });
    expect(learnedCardOf(row({ payload: null }))).toEqual({ status: "ready", card: null });
  });
});
