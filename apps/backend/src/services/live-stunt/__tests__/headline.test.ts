import { describe, it, expect } from "vitest";
import { distinctHeadline, isOwnerHeadline, plainHeadline, shownHeadline } from "../headline";

const PROD: [string, string][] = [
  [
    "Started research: From public pages only, find how Turo, Getaround's former US terms and other US peer-to-peer or rental services treat renters who fail a credit or insurance-score check.",
    "Started work on research.",
  ],
  ["Started Meta Ads: Raise the daily budget of the New Sales Campaign purchase ad set by $28/day as an approval card.", "Started work on Meta Ads."],
  ["Started Meta Ads: Read-only.", "Started work on Meta Ads."],
  ["Started Meta Ads: Read the live budget of 'a campaign' (an ad set) first, then propose raising it from $120 to $149 a day.", "Started work on Meta Ads."],
  ["Started content-design: Write two short scripts Upcar's support team can use today, with no engineering.", "Started work on content design."],
  ['Rejected the Meta Ads card "Pause the Broad Markets ad set after 14 days to hold the $2,100 cap".', 'Rejected the Meta Ads card "Pause the Broad Markets ad set after 14 days to hold the $2,100 cap".'],
  ['Rejected the Reddit Ads card "Confirm Reddit billing is approved before the $50/day campaign spends more".', 'Rejected the Reddit Ads card "Confirm Reddit billing is approved before the $50/day campaign spends more".'],
  ["Changed 7 budgets across Google and Meta.", "Changed 7 budgets across Google and Meta."],
  ["Raised Meta budget: $40 → $80/day.", "Raised Meta budget: $40 → $80/day."],
  ["Watched the numbers. Moved no money.", "Watched the numbers. Moved no money."],
  ["Started a new TikTok budget: $20/day.", "Started a new TikTok budget: $20/day."],
];

const SHAPES: [string, string, string][] = [
  ["brand casing", "Started a new Chatgpt budget: $25/day.", "Started a new ChatGPT budget: $25/day."],
  ["brand casing in a task label", "Started chatgpt_ads: Draft one ad.", "Started work on ChatGPT ads."],
  ["more brands", "Paused the tiktok and youtube ads, kept linkedin and meta ads.", "Paused the TikTok and YouTube ads, kept LinkedIn and Meta ads."],
  ["meta as a word is left alone", "Fixed the meta description.", "Fixed the meta description."],
  ["unclosed double quote is dropped", 'Rejected the Meta Ads card "Pause the Broad Mark', "Rejected the Meta Ads card."],
  ["unclosed curly quote is dropped", "Approved the card “Raise the budget", "Approved the card."],
  ["unclosed single quote is dropped, apostrophes kept", "Paused Upcar's ad set 'a camp", "Paused Upcar's ad set."],
  ["closed single quote kept", "Paused the ad set 'Broad' today.", "Paused the ad set 'Broad' today."],
  ["closed curly single quote kept", "Approved the card ‘Raise the budget’ today.", "Approved the card ‘Raise the budget’ today."],
  ["curly apostrophe is not a quote", "Paused Upcar’s ad set ‘a camp", "Paused Upcar’s ad set."],
  ["too long: first sentence", `Blocked 14 search terms that never book. ${"More detail here. ".repeat(10)}`, "Blocked 14 search terms that never book."],
  ["too long, one sentence: word cut, never mid-quote", `Rejected the card "${"word ".repeat(40)}"`, "Rejected the card."],
  ["missing full stop added", "Raised the Google budget", "Raised the Google budget."],
  ["empty stays empty", "   ", ""],
];

describe("plainHeadline", () => {
  it.each(PROD)("prod: %s", (input, out) => {
    expect(plainHeadline(input)).toBe(out);
  });
  it.each(SHAPES)("%s", (_name, input, out) => {
    expect(plainHeadline(input)).toBe(out);
  });
  it("is idempotent on every output", () => {
    for (const [i] of [...PROD, ...SHAPES.map(([, a]) => [a])]) expect(plainHeadline(plainHeadline(i))).toBe(plainHeadline(i));
  });
  it("never longer than a share card line", () => {
    for (const [i] of PROD) expect(plainHeadline(i).length).toBeLessThanOrEqual(120);
  });
});

describe("distinctHeadline", () => {
  const facts = { work: [], channels: [], spent_usd: null, bookings: null };
  it("a different headline from the day before is kept", () => {
    expect(distinctHeadline("Started work on Meta Ads.", ["Raised Google budget: $110 → $120/day."], facts)).toBe("Started work on Meta Ads.");
    expect(distinctHeadline("Started work on Meta Ads.", [], facts)).toBe("Started work on Meta Ads.");
  });
  it("a repeat takes the day's own next work line", () => {
    const work = ["Started Meta Ads: Read the live budget first.", "Started TikTok Ads: Read only."];
    expect(distinctHeadline("Started work on Meta Ads.", ["Raised Google budget.", "Started work on Meta Ads."], { ...facts, work })).toBe("Started work on TikTok Ads.");
  });
  it("a repeat with no new work line says the day's numbers", () => {
    expect(distinctHeadline("Watched the numbers. Moved no money.", ["watched the numbers -- moved no money"], { ...facts, spent_usd: 833.78, bookings: 38 })).toBe(
      "Spent $834 on ads and got 38 bookings that day.",
    );
    expect(distinctHeadline("Watched the numbers.", ["Watched the numbers."], { ...facts, bookings: 1 })).toBe("Got 1 booking that day.");
  });
  it("then the channels, then a plain follow-up line; never the same words or an '(again)' suffix", () => {
    expect(distinctHeadline("Changed a Meta budget.", ["Changed a Meta budget."], { ...facts, channels: ["Meta"] })).toBe("Kept working on Meta.");
    const last = distinctHeadline("Reviewed the numbers. Moved no money.", ["Reviewed the numbers. Moved no money."], facts);
    expect(last).toBe("Followed up on the previous day's work.");
    expect(last).not.toMatch(/again/i);
  });
});

describe("owner headline", () => {
  const draft = "Started Meta Ads: Read the live budget of 'a campaign' (an ad set) first, then propose raising it from $120 to $149 a day.";
  it("publishing the prefilled draft untouched is not an owner edit, so it is cleaned", () => {
    expect(isOwnerHeadline(draft, draft)).toBe(false);
    expect(shownHeadline(draft, draft)).toBe("Started work on Meta Ads.");
    const long = `Started research: ${"x ".repeat(150)}`;
    expect(isOwnerHeadline(long.slice(0, 200), long)).toBe(false);
    expect(isOwnerHeadline(long.slice(0, 80), long)).toBe(true);
  });
  it("the owner's own words are shown exactly as typed", () => {
    expect(isOwnerHeadline("Started: chatgpt 'test", draft)).toBe(true);
    expect(shownHeadline("Started: chatgpt 'test", draft)).toBe("Started: chatgpt 'test");
    expect(isOwnerHeadline(null, draft)).toBe(false);
  });
});
