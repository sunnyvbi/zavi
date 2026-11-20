import { describe, it, expect } from "vitest";
import { scrubPublicText, scrubPlaces, findIdentifiers } from "../scrub";

const names = ["Zavi · Hosts CA lookalike 2%", "Upcar Search - Brand"];
describe("scrubPublicText", () => {
  it("removes long numeric ids and act_ ids", () => {
    expect(scrubPublicText("Raised ad set 120214567890123 in act_998877665544", { campaignNames: [] })).toBe("Raised an ad set in an ad account");
  });
  it("replaces known campaign names (longest first)", () => {
    expect(scrubPublicText("Paused Zavi · Hosts CA lookalike 2% today", { campaignNames: names })).toBe("Paused a campaign today");
  });
  it("replaces any leftover 'Zavi · ...' name up to punctuation", () => {
    expect(scrubPublicText("Started Zavi · Renters TX broad. Budget up.", { campaignNames: [] })).toBe("Started a campaign. Budget up.");
  });
  it("strips urls, emails and phone numbers", () => {
    expect(scrubPublicText("see https://x.co/a ravi@upcar.ai +1 415 555 0100", { campaignNames: [] })).toBe("see [link] [email] [phone]");
  });
  it("a short campaign name only matches whole words", () => {
    expect(scrubPublicText("Discussed results for US renters", { campaignNames: ["US"] })).toBe("Discussed results for a campaign renters");
  });
  it("keeps ordinary ad copy and money amounts", () => {
    expect(scrubPublicText("Moved $100/day to “Earn with the car you already own”", { campaignNames: [] })).toBe("Moved $100/day to “Earn with the car you already own”");
  });
  it("writes ISO dates as words, so neither the phone rule nor the identifier check takes them", () => {
    const out = scrubPublicText("starting on approval (the 2026-10-17 midnight start had already passed) and ending 2026-10-22 04:00 (UTC).", { campaignNames: [] });
    expect(out).toBe("starting on approval (the Oct 17 midnight start had already passed) and ending Oct 22 04:00 (UTC).");
    expect(findIdentifiers(out)).toEqual([]);
    expect(scrubPublicText("ends 2026-10-21T23:59:00Z", { campaignNames: [] })).toBe("ends Oct 21 23:59:00Z");
  });
  it("only a price range after '$' is not a phone; a uuid is removed whole, never cut", () => {
    expect(scrubPublicText("Call (415) 555-0134 today", { campaignNames: [] })).toBe("Call [phone] today");
    expect(scrubPublicText("call4155550134 now", { campaignNames: [] })).toBe("call[phone] now");
    expect(scrubPublicText("Bids of $10.00-25.50 a day", { campaignNames: [] })).toBe("Bids of $10.00-25.50 a day");
    expect(scrubPublicText("Call 12 34 56 78 today", { campaignNames: [] })).toBe("Call [phone] today");
    expect(scrubPublicText("Call 12.34.56.78 today", { campaignNames: [] })).toBe("Call [phone] today");
    expect(scrubPublicText("Bids of $1000 - 2000 a day", { campaignNames: [] })).toBe("Bids of $1000 - 2000 a day");
    expect(scrubPublicText("Call $12 34 56 78 today", { campaignNames: [] })).toBe("Call $[phone] today");
    expect(scrubPublicText("Call $555.123-4567 today", { campaignNames: [] })).toBe("Call $[phone] today");
    expect(scrubPublicText("use video.mp4 (artifact f928e123-4567-89c7-bed3-498ee970388d).", { campaignNames: [] })).toBe("use video.mp4 (artifact).");
  });
  it("removes an id with its brackets and comma", () => {
    const opts = { campaignNames: ["Upcar Search - Brand"] };
    expect(scrubPublicText("Raise Upcar Search - Brand (1234567890) from $55/day", opts)).toBe("Raise a campaign from $55/day");
    expect(scrubPublicText("Resume the ad set (120212345678901234, New Sales Campaign, Purchase)", opts)).toBe("Resume the ad set (New Sales Campaign, Purchase)");
    expect(scrubPublicText("on the Upcar Pixel (123456789012345), lowest cost", opts)).toBe("on the Upcar Pixel, lowest cost");
    expect(scrubPublicText("Read 'Zavi · TikTok Traffic' (campaign 1234567890, ad group 1234567891) live first.", opts)).toBe(
      "Read 'a campaign' (a campaign, an ad group) live first.",
    );
  });
  it("a name inside 'the ... campaign' reads as one campaign; a leftover Zavi name keeps its closing quote", () => {
    const opts = { campaignNames: ["Regular Leads"] };
    expect(scrubPublicText("Stage one ad set in the Regular Leads campaign: optimized", opts)).toBe("Stage one ad set in a campaign: optimized");
    expect(scrubPublicText("The Regular Leads campaign spent $5.", opts)).toBe("A campaign spent $5.");
    expect(scrubPublicText("Read 'Zavi · TikTok Traffic': has it spent?", { campaignNames: [] })).toBe("Read 'a campaign': has it spent?");
    expect(scrubPublicText("Paused Zavi · Renter's push. Then", { campaignNames: [] })).toBe("Paused a campaign. Then");
    expect(scrubPublicText("Paused Zavi · Drivers' Retargeting today.", { campaignNames: [] })).toBe("Paused a campaign.");
    expect(scrubPublicText("Read 'Zavi · Drivers' Retargeting': has it spent?", { campaignNames: [] })).toBe("Read 'a campaign': has it spent?");
    expect(scrubPublicText("Paused “Zavi · Drivers' Retargeting today.", { campaignNames: [] })).toBe("Paused “a campaign”.");
    expect(scrubPublicText("Paused Zavi · Hosts 415.555.0134 today", { campaignNames: [] })).toBe("Paused a campaign");
  });
  it("caps length at 400 chars on a word boundary", () => {
    const out = scrubPublicText(("word ").repeat(200), { campaignNames: [] });
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith("word...")).toBe(true);
  });
});

describe("findIdentifiers", () => {
  it("finds uuids, grouped digit ids, act_, resource paths and Zavi names", () => {
    expect(findIdentifiers("tenant 73db45ff-457e-4541-bc8f-bdb625390204")).toHaveLength(1);
    expect(findIdentifiers("customer 123-456-7890")).toHaveLength(1);
    expect(findIdentifiers("id 1202 1456 7890")).toHaveLength(1);
    expect(findIdentifiers("act_12")).toHaveLength(1);
    expect(findIdentifiers("customers/99/campaigns")).toHaveLength(1);
    expect(findIdentifiers("adsets/5")).toHaveLength(1);
    expect(findIdentifiers("Zavi · X")).toHaveLength(1);
  });
  it("passes normal copy", () => {
    expect(findIdentifiers("Moved $100/day to Google search")).toEqual([]);
    expect(findIdentifiers("On day 13 Zavi added a Sunday ad")).toEqual([]);
    expect(findIdentifiers("$25,000 limit, 30 days")).toEqual([]);
  });
});

describe("scrubPlaces", () => {
  it("drops city names, keeping the sentence readable", () => {
    expect(scrubPlaces("Your homepage lists Los Angeles cars from $39/day, and renter demand is the stated constraint.")).toBe(
      "Your homepage lists local cars from $39/day, and renter demand is the stated constraint.",
    );
    expect(scrubPlaces("Moved budget to search in Las Vegas.")).toBe("Moved budget to search in one city.");
    expect(scrubPlaces("Phoenix and Miami both slowed.")).toBe("two cities both slowed.");
    expect(scrubPlaces("(Broad, Los Angeles, San Diego, Phoenix and Bay Area)")).toBe("(Broad, four cities)");
    expect(scrubPlaces("Targeted LA renters")).toBe("Targeted local renters");
  });
  it("drops city names in any case", () => {
    expect(scrubPlaces("Moved budget to LOS ANGELES and NEW YORK.")).toBe("Moved budget to two cities.");
    expect(scrubPlaces("Raised the miami budget")).toBe("Raised the local budget");
  });
  it("uses 'local' only before a noun, and catches all-caps PHOENIX and RENO", () => {
    expect(scrubPlaces("Paused Miami after the test.")).toBe("Paused one city after the test.");
    expect(scrubPlaces("Visited Los Angeles yesterday.")).toBe("Visited one city yesterday.");
    expect(scrubPlaces("PHOENIX and RENO slowed")).toBe("two cities slowed");
  });
  it("never splits a link or email that contains a city", () => {
    expect(scrubPublicText("Email ops@denver.com or see https://miami.example.com/report", { campaignNames: [] })).toBe(
      "Email [email] or see [link]",
    );
    expect(scrubPublicText("Email ops@denver.com", { campaignNames: ["Denver"] })).toBe("Email [email]");
    expect(scrubPublicText("See https://x.io and link ads", { campaignNames: ["link"] })).toBe("See [link] and a campaign ads");
  });
  it("leaves ordinary words alone", () => {
    expect(scrubPlaces("A phoenix rose; the label is clear; reno vations")).toBe("A phoenix rose; the label is clear; reno vations");
  });
  it("runs inside scrubPublicText after campaign names, so a name with a city in it is still caught whole", () => {
    expect(scrubPublicText("Paused Renters Los Angeles broad today", { campaignNames: ["Renters Los Angeles broad"] })).toBe("Paused a campaign today");
    expect(scrubPublicText("Raised the Houston budget", { campaignNames: [] })).toBe("Raised the local budget");
  });
});
