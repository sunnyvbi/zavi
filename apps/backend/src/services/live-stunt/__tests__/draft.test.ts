import { describe, it, expect } from "vitest";
import { buildDayDraft, type DraftInputs } from "../draft";

const base: DraftInputs = { day: "2026-10-03", isFirstDay: false, budgetChanges: [], changedLines: [], results: { spent_usd: 640, bookings: 15, hosts: 18 }, campaignNames: [] };

describe("buildDayDraft", () => {
  it("templates a single budget raise; neutral hides amounts, why and results", () => {
    const { full, neutral } = buildDayDraft({ ...base, budgetChanges: [{ channel_slug: "meta_ads", from_usd: 150, to_usd: 300, rationale: "Hosts at $28 each, under plan" }] });
    expect(full).toMatchObject({ kind: "CHANGE", headline: "Raised Meta budget: $150 → $300/day.", why: "Hosts at $28 each, under plan", budget: [{ channel: "Meta", from_usd: 150, to_usd: 300 }], spent_usd: 640 });
    expect(neutral).toMatchObject({ kind: "WORK", headline: "Changed a Meta budget.", why: null, budget: [{ channel: "Meta", from_usd: null, to_usd: null }], spent_usd: null, bookings: null, hosts: null });
  });
  it("no budget change: headline from the first changed line", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Blocked 14 search terms that never book. More detail.", "Wrote 3 headlines"] });
    expect(full.kind).toBe("WORK");
    expect(full.headline).toBe("Blocked 14 search terms that never book.");
    expect(full.work).toHaveLength(2);
  });
  it("a no-budget-change day's locked headline is fixed text, never the note", () => {
    const { full, neutral } = buildDayDraft({ ...base, changedLines: ["Creative A produced 12 bookings."] });
    expect(full.headline).toBe("Creative A produced 12 bookings.");
    expect(neutral.headline).toBe("Reviewed the numbers. Moved no money.");
  });
  it("only produces PLAN/CHANGE/WORK kinds", () => {
    expect(buildDayDraft({ ...base, isFirstDay: true, changedLines: ["Wrote the plan."] }).full.kind).toBe("PLAN");
    expect(buildDayDraft(base).full.kind).toBe("WORK");
  });
  it("scrubs campaign names; the locked (neutral) variant carries no free text at all", () => {
    const { full, neutral } = buildDayDraft({ ...base, campaignNames: ["Hosts CA LAL"], changedLines: ["Paused Hosts CA LAL at $80/day"] });
    expect(full.work[0]).toBe("Paused a campaign at $80/day");
    expect(neutral.work).toEqual([]);
  });
  it("drops any line that still has an identifier after scrubbing", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Raised customers/123/campaigns/9", "Kept the Sunday ad"], budgetChanges: [{ channel_slug: "google_ads", from_usd: 120, to_usd: 220, rationale: "see adsets/123/insights" }] });
    expect(full.work).toEqual(["Kept the Sunday ad"]);
    expect(full.why).toBeNull();
  });
  it("nothing happened and no pace: fixed text", () => {
    expect(buildDayDraft(base).full.headline).toBe("Watched the numbers. Moved no money.");
  });
  it("a quiet day still says how the day went, against a usual day, in ratios only", () => {
    const { full, neutral } = buildDayDraft({
      ...base,
      results: { spent_usd: 929, bookings: 52, hosts: 8, booking_value_usd: 14877 },
      pace: { bookings_per_week: 105, hosts_per_week: 84, booking_value_per_week: 38132 },
    });
    expect(full.headline).toBe("Bookings ran 3.5× a usual day. Moved no money.");
    expect(full.work).toEqual(["Bookings: 3.5× a usual day.", "Booking value: 2.7× a usual day.", "New hosts: 33% below a usual day."]);
    expect(full.headline).not.toMatch(/52|14,?877/);
    expect(neutral.headline).toBe("Reviewed the numbers. Moved no money.");
    expect(neutral.work).toEqual([]);
  });
  it("a quiet, ordinary day says so; a missing metric is skipped", () => {
    const { full } = buildDayDraft({ ...base, results: { spent_usd: 600, bookings: 15, hosts: null }, pace: { bookings_per_week: 105, hosts_per_week: 84 } });
    expect(full.headline).toBe("Bookings held at about a usual day. Moved no money.");
    expect(full.work).toEqual(["Bookings: about a usual day."]);
  });
});

describe("buildDayDraft why", () => {
  const rejected = `Rejected the Meta Ads card "Rebuild the campaign". This asks for the same rebuild as the newer card. I'm keeping that one.`;
  it("a reasoned note line gives its own reason as the why", () => {
    const { full, neutral } = buildDayDraft({ ...base, changedLines: [rejected] });
    expect(full.headline).toBe(`Rejected the Meta Ads card "Rebuild the campaign".`);
    expect(full.why).toBe("This asks for the same rebuild as the newer card. I'm keeping that one.");
    expect(neutral.why).toBeNull();
  });
  it("a Started line is a task brief, never a why", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Started Research: Pull cancelled trips. Report the split by reason."] });
    expect(full.why).toBeNull();
  });
  it("a Started line's why is cgo's own reason for that move, scrubbed", () => {
    const { full, neutral } = buildDayDraft({
      ...base,
      changedLines: ["Started research: From public pages only, find how rivals treat renters who fail a credit check."],
      moveReasons: [
        { channel_slug: "email_marketing", reason: "Hosts cancelled most of last month's lost bookings." },
        { channel_slug: "research", reason: "Low credit was the largest single decline reason. A deposit path is only worth building if others make it work." },
      ],
    });
    expect(full.why).toBe("Low credit was the largest single decline reason. A deposit path is only worth building if others make it work.");
    expect(neutral.why).toBeNull();
  });
  it("a Started ad-channel line finds its reason by cgo's channel name, not only the public label", () => {
    const { full } = buildDayDraft({
      ...base,
      changedLines: ["Started Meta Ads: Read the live budget first, then propose raising it from $120 to $149 a day."],
      moveReasons: [{ channel_slug: "meta_ads", reason: "This ad set spends its whole budget at the lowest cost per purchase." }],
    });
    expect(full.why).toBe("This ad set spends its whole budget at the lowest cost per purchase.");
  });
  it("a Started YouTube line takes the organic channel's reason, not YouTube Ads'", () => {
    const { full } = buildDayDraft({
      ...base,
      changedLines: ["Started YouTube: Draft three shorts."],
      moveReasons: [
        { channel_slug: "youtube_ads", reason: "Ads reason." },
        { channel_slug: "youtube_organic", reason: "Organic reason." },
      ],
    });
    expect(full.why).toBe("Organic reason.");
  });
  it("a Started line with no matching move reason still has no why", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Started Research: Pull cancelled trips."], moveReasons: [{ channel_slug: "email_marketing", reason: "Some other reason." }] });
    expect(full.why).toBeNull();
  });
  it("leads with a decision that has a reason over an earlier task line, and the why is that line's", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Started Email campaigns: Draft two emails.", rejected] });
    expect(full.headline).toBe(`Rejected the Meta Ads card "Rebuild the campaign".`);
    expect(full.why).toBe("This asks for the same rebuild as the newer card. I'm keeping that one.");
    expect(full.work).toHaveLength(2);
  });
  it("a reasoned line past the sixth still leads, and stays in the work list", () => {
    const tasks = Array.from({ length: 7 }, (_, n) => `Started Research: Task ${n}.`);
    const { full } = buildDayDraft({ ...base, changedLines: [...tasks, rejected] });
    expect(full.headline).toBe(`Rejected the Meta Ads card "Rebuild the campaign".`);
    expect(full.work).toHaveLength(6);
    expect(full.work[5]).toBe(rejected);
  });
  it("only task lines: first line leads, no why", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Started Email campaigns: Draft two emails.", "Started Research: Pull trips."] });
    expect(full.headline).toBe("Started work on email campaigns.");
    expect(full.why).toBeNull();
  });
  it("a decision whose reason was already used does not lead; the day falls back to its first line", () => {
    const { full } = buildDayDraft({ ...base, changedLines: ["Started Research: Pull trips.", rejected], priorWhys: ["This asks for the same rebuild as the newer card. I'm keeping that one."] });
    expect(full.headline).toBe("Started work on research.");
    expect(full.why).toBeNull();
  });
  it("Goal lines (private numbers) never reach the headline, why or work", () => {
    const goal = `Goal "Grow my MRR to 100k": due Sep 30 to Dec 31. Sep 30 is effectively missed at $895. Extending to Dec 31.`;
    const { full } = buildDayDraft({ ...base, changedLines: [goal, "Started Research: Pull trips."] });
    expect(full.headline).toBe("Started work on research.");
    expect(full.work).toEqual(["Started Research: Pull trips."]);
    expect(JSON.stringify(full)).not.toContain("895");
    expect(buildDayDraft({ ...base, changedLines: [goal] }).full.headline).toBe("Watched the numbers. Moved no money.");
  });
  it("never repeats an earlier day's why (draft or owner edit), ignoring case and punctuation", () => {
    const prior = ["this asks for the same rebuild as the newer card -- I'm keeping that one"];
    expect(buildDayDraft({ ...base, changedLines: [rejected], priorWhys: prior }).full.why).toBeNull();
  });
  it("a budget day skips a used rationale and takes the next change's own", () => {
    const { full } = buildDayDraft({
      ...base,
      priorWhys: ["Hosts at $28 each, under plan"],
      budgetChanges: [
        { channel_slug: "meta_ads", from_usd: 150, to_usd: 300, rationale: "Hosts at $28 each, under plan" },
        { channel_slug: "google_ads", from_usd: 100, to_usd: 50, rationale: "Search clicks stopped booking" },
      ],
    });
    expect(full.why).toBe("Search clicks stopped booking");
  });
  it("a single budget change whose only rationale was used gets no why, never another change's text", () => {
    const { full } = buildDayDraft({ ...base, changedLines: [rejected], priorWhys: ["Hosts at $28 each, under plan"], budgetChanges: [{ channel_slug: "meta_ads", from_usd: 150, to_usd: 300, rationale: "Hosts at $28 each, under plan" }] });
    expect(full.why).toBeNull();
  });
  it("guard: the legacy changed lines draft exactly as before the note rebuild", () => {
    const out = buildDayDraft({ ...base, changedLines: ["Started Google Ads: keep budgets.", 'Rejected the YouTube Ads card "X". Google turned it down.'] });
    expect(out.full).toEqual({
      day: "2026-10-03",
      kind: "WORK",
      headline: 'Rejected the YouTube Ads card "X".',
      channels: [],
      work: ["Started Google Ads: keep budgets.", 'Rejected the YouTube Ads card "X". Google turned it down.'],
      why: "Google turned it down.",
      budget: [],
      spent_usd: 640,
      bookings: 15,
      hosts: 18,
    });
    expect(out.neutral).toEqual({ day: "2026-10-03", kind: "WORK", headline: "Reviewed the numbers. Moved no money.", channels: [], work: [], why: null, budget: [], spent_usd: null, bookings: null, hosts: null });
  });
  it("a task line's headline is the channel, never cgo's brief to it", () => {
    const line = "Started Meta Ads: Read the live budget of 'a campaign' (an ad set) first, then propose raising it from $120 to $149 a day.";
    const { full } = buildDayDraft({ ...base, changedLines: [line] });
    expect(full.headline).toBe("Started work on Meta Ads.");
    expect(full.work).toEqual([line]);
  });
  it("never repeats an earlier published day's headline", () => {
    const meta = "Started Meta Ads: Read the live budget first.";
    expect(buildDayDraft({ ...base, changedLines: [meta, "Started TikTok Ads: Read only."], priorHeadlines: ["Started work on Meta Ads."] }).full.headline).toBe("Started work on TikTok Ads.");
    expect(buildDayDraft({ ...base, priorHeadlines: ["Watched the numbers. Moved no money."] }).full.headline).toBe("Spent $640 on ads and got 15 bookings that day.");
    expect(buildDayDraft({ ...base, changedLines: [meta], priorHeadlines: ["Raised Google budget: $110 → $120/day."] }).full.headline).toBe("Started work on Meta Ads.");
  });
  it("a ChatGPT budget is cased the way the brand writes it", () => {
    const { full } = buildDayDraft({ ...base, budgetChanges: [{ channel_slug: "chatgpt_ads", from_usd: 0, to_usd: 25, rationale: null }] });
    expect(full.headline).toBe("Started a new ChatGPT budget: $25/day.");
  });
});
