import { describe, expect, it } from "vitest";
import { buildNoteItems, channelCardNoteItem, cleanReason, deriveHeadline, headlineClaimsAction, isNoOpLead, itemText, noteHasUndoable, noteHeadline, noteItemsVisible, noteSections, parseNoteItems, renderNoteItemLine, stripInternalIds, validHeadline, type NoteItem } from "../cgo-note-items";
import { renderCgoNoteEmail } from "@/email/templates/cgo-note";
import { noteRowFix, renderCgoNoteSlack } from "../cgo-note-slack";

describe("stripInternalIds", () => {
  it.each([
    ["Create the campaign “Upcar - YouTube - Bay Area - zavi-brief-18df3c487111”", "Create the campaign “Upcar - YouTube - Bay Area”"],
    ["Fix sign_up_complete in Google Ads (8 hidden signups — follow-up on [9358264e])", "Fix sign_up_complete in Google Ads (8 hidden signups)"],
    ["[9358264e] Fix the pixel", "Fix the pixel"],
    ["Same as card 5796afb7-15c8-47f9-9d85-40426982b5ce, retried", "Same as card, retried"],
    ["Retry (run 2d1937df)", "Retry"],
    ["Card 9358264e is stale", "Card is stale"],
    ["zavi-card-a1b2c3d4 duplicate", "duplicate"],
    ["decision id: 931ad19b failed", "failed"],
    ["zavi-brief-18df3c487111", ""],
  ])("strips %s", (i, o) => expect(stripInternalIds(i)).toBe(o));
  it.each([
    "follow-up email on Tuesday", "re-filed card", "Fix sign_up_complete: set Include in Conversions to Yes",
    "Google Search spent $467.97 in the last 7 days", "Due 2026-09-30", "From Oct 1 to 7, keep budgets",
    "Upcar - YouTube - Bay Area", "Upcar.ai | Search ($25/day)", "A/B test the hook", "[Draft] launch post", "[beta] feature",
    "[deadbeef] is all letters", "[20260930] is all digits", "campaign 22714683102 (a Google id)", "zavi-briefing notes",
    "e-mail the list", "cafe1234 unbracketed", "Card 3 of 5", "run 10k ads", "Version 2a is live", "card abc", "ID verification step",
  ])("keeps %s", (s) => expect(stripInternalIds(s)).toBe(s));
});

describe("itemText / cleanReason / headline", () => {
  it("valid action is used; over 60 chars is DROPPED for the cleaned title, never truncated", () => {
    expect(itemText("Have your developer add hashed email to CAPI", "x")).toBe("Have your developer add hashed email to CAPI");
    expect(itemText("x".repeat(61), "Fix sign_up_complete (8 hidden — follow-up on [9358264e])")).toBe("Fix sign_up_complete (8 hidden)");
    expect(itemText("ok", "Title here")).toBe("Title here");
    expect(itemText("[9358264e]", "Title here")).toBe("Title here");
  });
  it("reason stripped, capitalized, no 'because', no trailing period", () => {
    expect(cleanReason("because the bid still shows manual CPV.")).toBe("The bid still shows manual CPV");
    expect(cleanReason("  ")).toBeUndefined();
  });
  it("headline: valid kept (ids stripped); invalid or missing derived from items", () => {
    expect(validHeadline("Fix [9358264e] first: Google counts 0 sign-ups")).toBe("Fix first: Google counts 0 sign-ups");
    expect(validHeadline("ok")).toBeNull();
    expect(deriveHeadline([{ section: "needs_you", text: "Count sign-ups as conversions", action_id: "a" }, { section: "needs_you", text: "B", action_id: "b" }])).toBe("2 things need you. First: Count sign-ups as conversions.");
    expect(deriveHeadline([{ section: "blocked", text: "Create YT", action_id: "c", channel_slug: "youtube_ads" }])).toBe("Google refused one change; nothing for you to do.");
    expect(deriveHeadline([{ section: "blocked", text: "Pause", action_id: "d", channel_slug: "meta_ads" }])).toBe("A platform refused one change; nothing for you to do.");
    expect(deriveHeadline([])).toBeNull();
    expect(deriveHeadline([{ section: "needs_you", text: "Keep Reddit? If you don't answer by Oct 3, I'll pause it.", question_ordinal: 1 }, { section: "needs_you", text: "Count sign-ups", action_id: "a" }])).toBe("2 things need you. First: Count sign-ups.");
    expect(deriveHeadline([{ section: "needs_you", text: "Keep Reddit?", question_ordinal: 1 }])).toBe("1 question for you.");
  });
});

const n = (o: Partial<NoteItem>): NoteItem => ({ section: "needs_you", text: "t", ...o });
describe("buildNoteItems", () => {
  it("strips internal ids from every item, questions included, and drops an item left empty", () => {
    const out = buildNoteItems([
      n({ text: "Should I retry [9358264e] on zavi-brief-18df3c487111?", question_ordinal: 1 }),
      n({ text: "9358264e-5263-48aa-8a0c-77fbb422a2ed", question_ordinal: 2 }),
      n({ text: "Count sign-ups", reason: "See card [9358264e].", action_id: "a" }),
    ]);
    expect(out.map((i) => i.text).join(" ")).not.toMatch(/9358264e|zavi-brief-/);
    expect(out.find((i) => i.action_id === "a")?.reason).not.toMatch(/9358264e/);
    expect(out.some((i) => i.question_ordinal === 2)).toBe(false);
  });
  it("a blocked card is never in Needs you", () => expect(buildNoteItems([n({ action_id: "a" })], new Set(["a"])).map((i) => i.section)).toEqual(["blocked"]));
  it("one line per chain root; needs_you > blocked > changed > working_on", () => {
    expect(buildNoteItems([n({ section: "changed", action_id: "o", chain_root_id: "o", text: "Rejected: YT" }), n({ action_id: "w", chain_root_id: "o", text: "Create YT" })]).map((i) => i.text)).toEqual(["Create YT"]);
  });
  it("distinct chains with identical text both stay", () => expect(buildNoteItems([n({ action_id: "a", text: "Same" }), n({ action_id: "b", text: "Same" })])).toHaveLength(2));
  it("ranks Needs you by money, then oldest waiting", () => {
    expect(buildNoteItems([n({ action_id: "c", text: "C", waiting_since: "2026-09-28T00:00:00Z" }), n({ action_id: "a", text: "A", usd_at_stake: 468 }), n({ action_id: "b", text: "B", waiting_since: "2026-09-20T00:00:00Z" })]).map((i) => i.text)).toEqual(["A", "B", "C"]);
  });
});

describe("noteSections: the one layout", () => {
  const link = (i: NoteItem) => (i.action_id && i.channel_slug ? `/c/${i.action_id}` : null);
  it("only Needs you's N more jumps to step 5; other sections and a link that has a hash keep theirs", () => {
    const cards = (section: NoteItem["section"]) =>
      Array.from({ length: 12 }, (_, i) => n({ section, action_id: `${section}${i}`, channel_slug: `ch${i}`, text: `${section} ${i}` }));
    const s = noteSections(buildNoteItems([...cards("needs_you"), ...cards("changed")]), { wouldChange: [], link, moreUrl: "https://z/workspace?tab=growth-strategy" });
    expect(s.find((x) => x.key === "needs_you")?.more?.url).toBe("https://z/workspace?tab=growth-strategy#growth-needs");
    expect(s.find((x) => x.key === "changed")?.more?.url).toBe("https://z/workspace?tab=growth-strategy");
    const hashed = noteSections(buildNoteItems(cards("needs_you")), { wouldChange: [], link, moreUrl: "/g#x" });
    expect(hashed[0].more?.url).toBe("/g#x");
    expect(noteSections(buildNoteItems(cards("needs_you")), { wouldChange: [], link, moreUrl: "" })[0].more?.url).toBe("");
  });

  it("spec order, empty sections hidden, every question kept, overflow is an explicit N more row", () => {
    const items = [
      ...Array.from({ length: 7 }, (_, i) => n({ text: `Q${i}?`, question_ordinal: i + 1 })),
      ...Array.from({ length: 8 }, (_, i) => n({ action_id: `c${i}`, channel_slug: `seo${i}`, text: `C${i}` })),
      n({ section: "blocked", action_id: "b", text: "Create YT", reason: "Google Ads refused this change. We've been alerted; nothing for you to do" }),
    ];
    const s = noteSections(buildNoteItems(items), { wouldChange: [], link, moreUrl: "/growth" });
    expect(s.map((x) => x.key)).toEqual(["needs_you", "blocked"]);
    expect(s[0].rows.filter((r) => r.question_ordinal).length).toBe(7);
    expect(s[0].rows.filter((r) => !r.question_ordinal).length).toBe(5);
    expect(s[0].more).toEqual({ count: 3, url: "/growth#growth-needs", line: "3 more on your Growth page." });
    expect(s[0].rows.find((r) => r.line.startsWith("C0"))?.url).toBe("/c/c0");
  });
  it("What I'd change (advice) sits after What I changed", () => {
    expect(noteSections([n({ section: "changed", text: "Paused Reddit", undoable: true, channel_slug: "reddit_organic" })], { wouldChange: ["Try TikTok."], link, moreUrl: "/g" }).map((x) => x.key)).toEqual(["changed", "would_change"]);
  });
});

describe("render / visibility / undo", () => {
  it("line: text, then reason; no money suffix; question lines untouched", () => {
    expect(renderNoteItemLine(n({ text: "Count sign-ups", usd_at_stake: 468, reason: "$468 spent with 0 counted sign-ups" }))).toBe("Count sign-ups. $468 spent with 0 counted sign-ups.");
    expect(renderNoteItemLine(n({ text: "Keep Reddit?", question_ordinal: 1 }))).toBe("Keep Reddit?");
  });
  it("visible when there are items (a blocked-only note is visible)", () => {
    expect(noteItemsVisible([n({ section: "blocked", text: "x", action_id: "a" })], [])).toBe(true);
    expect(noteItemsVisible([], [])).toBe(false);
  });
  it("refund guidance only for an undoable change", () => {
    expect(noteHasUndoable([n({ section: "changed", text: "Rejected: YT" })])).toBe(false);
    expect(noteHasUndoable([n({ section: "changed", text: "Goal", undoable: true })])).toBe(true);
  });
});

describe("channelCardNoteItem (shared by goal-owner and decision-replay)", () => {
  const row = { id: "r", channel_slug: "google_ads", title: "Raise budget", proposed_at: "2026-09-29T00:00:00Z" };
  it.each([
    ["leave", null, "needs_you"], ["leave", "blocked_on_us", "blocked"], ["reject", null, "decided"],
    ["approve_queued", null, "working_on"], ["approve_executed", null, "changed"],
    ["approve_failed", "needs_founder", "needs_you"], ["approve_failed", "blocked_on_us", "blocked"], ["sent_back", null, "working_on"],
  ])("%s with %s → %s", (outcome, bucket, section) => {
    expect(channelCardNoteItem({ outcome: outcome as never, row, bucket: bucket as never, action: "Raise Search to $40/day", why: "0 conversions", usd: 100, platform: "Google Ads", fixText: "reconnect Google Ads in Settings" }).section).toBe(section);
  });
  it("words", () => {
    const base = { row, action: "Raise Search to $40/day", why: "", usd: null, platform: "Google Ads", fixText: null };
    expect(channelCardNoteItem({ ...base, outcome: "approve_queued", bucket: null }).text).toBe("Applying: Raise Search to $40/day");
    expect(channelCardNoteItem({ ...base, outcome: "approve_executed", bucket: null }).text).toBe("Applied: Raise Search to $40/day");
    const blocked = channelCardNoteItem({ ...base, outcome: "leave", bucket: "blocked_on_us", usd: 5 });
    expect(blocked.reason).toBe("Google Ads refused this change. We've been alerted; nothing for you to do");
    expect(blocked.usd_at_stake).toBeUndefined();
    expect(channelCardNoteItem({ ...base, outcome: "approve_failed", bucket: "needs_founder", fixText: "reconnect Google Ads in Settings" }).reason).toBe("This needs you: reconnect Google Ads in Settings");
  });
});

describe("edges", () => {
  it("within a chain the root's own item wins a tie and keeps the chain's largest money", () => {
    const out = buildNoteItems([
      n({ action_id: "child", chain_root_id: "root", text: "Count sign-ups as conversions" }),
      n({ action_id: "root", chain_root_id: "root", text: "Count sign-ups as conversions in Google Ads", usd_at_stake: 468 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action_id: "root", usd_at_stake: 468 });
    const out2 = buildNoteItems([
      n({ action_id: "root", chain_root_id: "root", text: "Root" }),
      n({ action_id: "child", chain_root_id: "root", text: "Child", usd_at_stake: 50 }),
    ]);
    expect(out2[0]).toMatchObject({ action_id: "root", usd_at_stake: 50 });
  });
  it("a forced-blocked card loses its prefix, money, undo and cgo reason; it gets the honest words", () => {
    const [b] = buildNoteItems([n({ section: "changed", action_id: "a", text: "Rejected: Create YT", undoable: true, usd_at_stake: 9 })], new Set(["a"]));
    expect(b).toEqual({ section: "blocked", action_id: "a", text: "Create YT", reason: "The platform refused this change. We've been alerted; nothing for you to do" });
  });
  it("questions lead Needs you in ordinal order, ahead of money", () => {
    const out = buildNoteItems([n({ action_id: "a", text: "A", usd_at_stake: 900 }), n({ text: "Q2?", question_ordinal: 2 }), n({ text: "Q1?", question_ordinal: 1 })]);
    expect(out.map((i) => i.text)).toEqual(["Q1?", "Q2?", "A"]);
  });
  it("an unparseable waiting_since sorts last, never NaN-scrambled", () => {
    const out = buildNoteItems([n({ action_id: "x", text: "X", waiting_since: "garbage" }), n({ action_id: "y", text: "Y", waiting_since: "2026-09-01T00:00:00Z" })]);
    expect(out.map((i) => i.text)).toEqual(["Y", "X"]);
  });
  it("approve_failed wording per bucket, never cgo's approve reason", () => {
    const base = { outcome: "approve_failed" as const, row: { id: "r", channel_slug: "meta_ads", title: "T" }, action: "Raise the ad set to $40", why: "0 conversions", usd: null, platform: "Meta Ads", fixText: null };
    expect(channelCardNoteItem({ ...base, bucket: "temporary" }).reason).toBe("Meta Ads did not take it this time. Try again on the card");
    expect(channelCardNoteItem({ ...base, bucket: "partial_risk" }).reason).toBe("Part of it may already be live on Meta Ads. Check there before trying again");
    expect(channelCardNoteItem({ ...base, bucket: "needs_founder" }).reason).toBe("Meta Ads needs a fix on your side before this can run");
  });
  it("reasons and titles are stripped of ids too", () => {
    const i = channelCardNoteItem({ outcome: "leave", row: { id: "r", channel_slug: "google_ads", title: "Fix it — follow-up on [9358264e]" }, bucket: null, action: null, why: "because see [9358264e] for the $468", usd: null, platform: "Google Ads", fixText: null });
    expect(i.text).toBe("Fix it");
    expect(i.reason).toBe("For the $468");
  });
  it("parseNoteItems drops malformed entries and keeps typed fields only", () => {
    expect(parseNoteItems(null)).toBeNull();
    expect(parseNoteItems("x")).toBeNull();
    expect(parseNoteItems([null, 3, { section: "nope", text: "x" }, { section: "blocked", text: "" }, { section: "blocked", text: "ok", usd_at_stake: "9", undoable: "yes", question_ordinal: 1.5, action_id: 7 }])).toEqual([{ section: "blocked", text: "ok" }]);
    expect(parseNoteItems([{ section: "changed", text: "Paused X", undoable: true, channel_slug: "reddit_organic", goal_id: "g" }])).toEqual([{ section: "changed", text: "Paused X", undoable: true, channel_slug: "reddit_organic", goal_id: "g" }]);
  });
  it("a long reason is cut at a sentence or a word, never mid-word", () => {
    const r = cleanReason(`${"Spend rose ".repeat(30)}end.`)!;
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.endsWith("…")).toBe(true);
  });
});

describe("the location picker row (PLAN-ad-location-picker)", () => {
  it("survives storage and links to the channel's picker", async () => {
    const { parseNoteItems, noteSections } = await import("../cgo-note-items");
    const items = parseNoteItems([{ section: "needs_you", text: "Pick where your Google Ads show", reason: "Your new campaign runs across the United States until you do", channel_slug: "google_ads", locations: true }])!;
    expect(items[0].locations).toBe(true);
    const view = noteSections(items, {
      wouldChange: [],
      moreUrl: "/m",
      link: (i) => (i.locations && i.channel_slug ? `/workspace?tab=channels&channel=${i.channel_slug}&locations=1` : null),
    });
    expect(view[0].rows[0]).toMatchObject({
      line: "Pick where your Google Ads show. Your new campaign runs across the United States until you do.",
      url: "/workspace?tab=channels&channel=google_ads&locations=1",
    });
  });
});

describe("the monthly ad budget a raise needs", () => {
  const raise = { section: "needs_you" as const, text: "Raise Northwind Sales Search to $110/day", reason: "It spends its whole budget", action_id: "a-1", channel_slug: "google_ads", budget_from_usd: 25000, budget_to_usd: 25966 };

  it("is stated on the line, survives storage, and is dropped from a blocked item", async () => {
    const { buildNoteItems, parseNoteItems, renderNoteItemLine } = await import("../cgo-note-items");
    expect(renderNoteItemLine(raise)).toBe("Raise Northwind Sales Search to $110/day. It spends its whole budget. This also raises your monthly ad budget from $25,000 to $25,966.");
    const stored = parseNoteItems(JSON.parse(JSON.stringify(buildNoteItems([raise]))))!;
    expect(stored[0]).toMatchObject({ budget_from_usd: 25000, budget_to_usd: 25966 });
    expect(buildNoteItems([raise], new Set(["a-1"]))[0]).not.toHaveProperty("budget_to_usd");
    expect(parseNoteItems([{ ...raise, budget_to_usd: 24000 }])![0]).not.toHaveProperty("budget_to_usd");
    expect(renderNoteItemLine({ ...raise, section: "changed" })).not.toMatch(/monthly ad budget/);
  });
});

describe("what the card does, as code wrote it", () => {
  it("is shown on the Needs you line before the budget sentence, survives storage, and is dropped from a blocked item", async () => {
    const { buildNoteItems, parseNoteItems, renderNoteItemLine } = await import("../cgo-note-items");
    const i = { section: "needs_you" as const, text: "Raise Northwind Sales Search", reason: "It spends its whole budget", action_id: "a-1", channel_slug: "google_ads", card_change: "Zavi changes the daily budget of “Northwind” from $55 to $110.", budget_from_usd: 25000, budget_to_usd: 25966 };
    expect(renderNoteItemLine(i)).toBe(
      "Raise Northwind Sales Search. It spends its whole budget. If you say yes: Zavi changes the daily budget of “Northwind” from $55 to $110. This also raises your monthly ad budget from $25,000 to $25,966.",
    );
    expect(parseNoteItems(JSON.parse(JSON.stringify(buildNoteItems([i]))))![0].card_change).toBe(i.card_change);
    expect(buildNoteItems([i], new Set(["a-1"]))[0]).not.toHaveProperty("card_change");
    expect(renderNoteItemLine({ ...i, section: "working_on" })).not.toMatch(/If you say yes/);
  });
});

describe("the plan line item", () => {
  it("survives a stored round trip and is never the derived headline", async () => {
    const { parseNoteItems, deriveHeadline } = await import("../cgo-note-items");
    const stored = JSON.parse(JSON.stringify([{ section: "working_on", text: "To reach more people for this goal, SEO would help most.", plans: true }]));
    const items = parseNoteItems(stored)!;
    expect(items[0].plans).toBe(true);
    expect(deriveHeadline(items)).toBeNull();
    expect(deriveHeadline([...items, { section: "working_on", text: "Research: count trips" }])).toBe("Working on Research: count trips.");
  });
});

describe("grouped rows: many cards waiting on one channel", () => {
  const VIDEO_TITLES = [
    "Product demo: Toyota RAV4, Burlingame, 2 trips, $55 a day. Read that card in five seconds.",
    "Explainer: 29 trips and 5.0 stars at $59 a day, or New at $75. Which one?",
    "Hook: New. Zero trips. Would you book it?",
    "Behind the scenes: One search, then look at trips before price. Step by step.",
    "Offer: Rentals from $30 a day. Here's what $30 and $59 each get you.",
  ];
  const video = (title: string, n: number, delivered = false): NoteItem =>
    channelCardNoteItem({
      outcome: "leave",
      row: { id: `0000000${n}-0000-4000-8000-00000000000${n}`, channel_slug: "generated_video", title },
      bucket: null,
      action: "Founder decides whether to publish this video",
      why: "$0 of ad money on it. Whether to post a video is the founder's call",
      usd: 0,
      platform: "AI UGC Videos",
      fixText: null,
      delivered,
    });
  const question: NoteItem = { section: "needs_you", text: "I'll count \"GMV growth stunt\" as paid trips. Use this?", question_ordinal: 2 };
  const real = (): NoteItem[] => [question, ...VIDEO_TITLES.map((t, k) => video(t, k + 1, k === 0))];
  const sections = (items: NoteItem[]) => noteSections(items, { wouldChange: [], link: () => "card-url", moreUrl: "more", channelLink: (s) => `page:${s}` });

  it("the five videos become ONE row with one link to the channel page, each video named by its own title", () => {
    const rows = sections(real()).find((s) => s.key === "needs_you")!.rows;
    expect(rows).toHaveLength(2);
    const g = rows[1];
    expect(g.line).toBe("5 AI videos are waiting on you");
    expect(g.url).toBe("page:generated_video");
    expect(g.label).toBe("Open videos");
    expect(g.item).toBeUndefined();
    expect(g.group!.lines).toEqual([
      "Product demo: Toyota RAV4, Burlingame, 2 trips, $55 a day. Read that card in five seconds · made, not posted yet",
      "Explainer: 29 trips and 5.0 stars at $59 a day, or New at $75. Which one? · script only, not made yet",
      "Hook: New. Zero trips. Would you book it? · script only, not made yet",
      "Behind the scenes: One search, then look at trips before price. Step by step · script only, not made yet",
      "Offer: Rentals from $30 a day. Here's what $30 and $59 each get you · script only, not made yet",
    ]);
    expect([g.line, ...g.group!.lines, g.group!.note].join(" ")).not.toMatch(/Founder decides|\$0 of ad money/);
  });

  it("a video being made says so, never 'script only'", () => {
    const making = { ...video(VIDEO_TITLES[2], 3), making: true };
    const back = parseNoteItems(JSON.parse(JSON.stringify([video(VIDEO_TITLES[0], 1), video(VIDEO_TITLES[1], 2), making])))!;
    expect(sections(back).find((s) => s.key === "needs_you")!.rows[0].group!.lines[2]).toBe("Hook: New. Zero trips. Would you book it? · being made now");
  });

  it("the headline counts the group as one thing and leads with it", () => {
    expect(deriveHeadline(buildNoteItems(real()))).toBe("2 things need you. First: 5 AI videos are waiting on you.");
  });

  it("grouping survives a stored note (title and delivered round-trip)", () => {
    const back = parseNoteItems(JSON.parse(JSON.stringify(real())))!;
    expect(back[1].title).toBe("Product demo: Toyota RAV4, Burlingame, 2 trips, $55 a day. Read that card in five seconds");
    expect(back[1].delivered).toBe(true);
    expect(sections(back).find((s) => s.key === "needs_you")!.rows[1].group!.count).toBe(5);
  });

  it("any channel groups at 3 cards; an ad raise keeps its budget sentence", () => {
    const ad = (n: number, extra: Partial<NoteItem> = {}): NoteItem => ({ section: "needs_you", text: `Raise ad set ${n}`, title: `Ad set ${n}`, action_id: `a${n}`, channel_slug: "meta_ads", ...extra });
    const rows = sections([ad(1, { budget_from_usd: 500, budget_to_usd: 800 }), ad(2), ad(3)]).find((s) => s.key === "needs_you")!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe("3 Meta Ads cards are waiting on you");
    expect(rows[0].label).toBe("Open");
    expect(rows[0].group!.lines[0]).toBe("Ad set 1 · This also raises your monthly ad budget from $500 to $800");
  });

  it("two cards on a channel stay separate rows, each with its own link", () => {
    const second = { ...video(VIDEO_TITLES[1], 2), text: "Founder decides whether to post the explainer" };
    const rows = sections([question, video(VIDEO_TITLES[0], 1), second]).find((s) => s.key === "needs_you")!.rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.group)).toBe(true);
    expect(rows[1].url).toBe("card-url");
    expect(deriveHeadline([question, video(VIDEO_TITLES[0], 1), second])).toMatch(/^3 things need you\./);
  });

  it("MUST CATCH (codex, pre-deploy #4128): a note stored before grouping (no titles) keeps one line per card", () => {
    const old = real().map((i) => {
      const { title: _t, delivered: _d, making: _m, ...rest } = i as NoteItem & { making?: boolean };
      return rest as NoteItem;
    });
    const rows = sections(old).find((s) => s.key === "needs_you")!.rows;
    expect(rows.some((r) => r.group)).toBe(false);
    const cards = rows.filter((r) => r.item?.action_id);
    expect(cards).toHaveLength(1);
    expect(cards[0].fold!.items.map((i) => i.action_id)).toEqual(old.slice(1).map((i) => i.action_id));
  });

  it("questions, location pickers and the plan line are never grouped", () => {
    const loc = (n: number): NoteItem => ({ section: "needs_you", text: `Pick where ads show ${n}`, channel_slug: "meta_ads", locations: true });
    const qs = [1, 2, 3].map((n): NoteItem => ({ section: "needs_you", text: `Question ${n}?`, question_ordinal: n, channel_slug: "meta_ads" }));
    const rows = sections([...qs, loc(1), loc(2), loc(3)]).find((s) => s.key === "needs_you")!.rows;
    expect(rows.some((r) => r.group)).toBe(false);
    expect(rows).toHaveLength(6);
  });

  it("a location picker on a grouped channel still counts, and still leads when it comes first", () => {
    const ad = (n: number): NoteItem => ({ section: "needs_you", text: `Raise ad set ${n}`, action_id: `a${n}`, channel_slug: "meta_ads", title: `Ad set ${n}` });
    const picker: NoteItem = { section: "needs_you", text: "Pick where your Meta ads show", channel_slug: "meta_ads", locations: true };
    const items = [picker, ad(1), ad(2), ad(3)];
    expect(sections(items).find((s) => s.key === "needs_you")!.rows).toHaveLength(2);
    expect(deriveHeadline(items)).toBe("2 things need you. First: Pick where your Meta ads show.");
  });

  it("other sections are never grouped", () => {
    const changed = [1, 2, 3].map((n): NoteItem => ({ section: "changed", text: `Applied: thing ${n}`, action_id: `c${n}`, channel_slug: "meta_ads" }));
    expect(sections(changed).find((s) => s.key === "changed")!.rows.some((r) => r.group)).toBe(false);
  });
});

describe("headlineClaimsAction", () => {
  it("any headline saying cgo did something gives way to the server's", () => {
    for (const h of [
      "I'm putting $24 more a day on Weekend promo.",
      "I\u2019m raising Weekend promo from $120 to $144 a day.",
      "I raised the Weekend promo budget to $144.",
      "I've paused Reddit Ads: 101 clicks, no sign-ups.",
      "I approved the Meta Ads raise.",
      "I'm raising the Meta budget and started Research on rebookings.",
    ]) expect(headlineClaimsAction(h)).toBe(true);
  });

  it("leaves headlines that report, ask or plan alone", () => {
    for (const h of [
      "Weekend promo is the only ad set buying purchases cheaply.",
      "I'm proposing to put $24 on Weekend promo.",
      "I'll raise Weekend promo once you approve.",
      "Should I leave the rest of the ad budget unspent?",
      "4 things need you. First: 4 TikTok Ads cards are waiting on you.",
      "I could not count bookings: your app database is not connected.",
    ]) expect(headlineClaimsAction(h)).toBe(false);
  });
});

describe("urgent blockers survive the visible cap", () => {
  it("a money-at-risk row past the cap is pinned, not pushed into 'N more'", async () => {
    const { noteSections } = await import("../cgo-note-items");
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ section: "needs_you" as const, text: `Card ${i}` })),
      { section: "needs_you" as const, text: "Reconnect TikTok Ads: spend unreadable", blocker_id: "ad_read_failed:b1:tiktok:2026-10", blocker_severity: "urgent" as const },
    ];
    const s = noteSections(items, { wouldChange: [], link: () => null, moreUrl: "/g" })[0];
    expect(s.rows.some((r) => r.line.startsWith("Reconnect TikTok Ads"))).toBe(true);
    expect(s.rows[0].line.startsWith("Reconnect TikTok Ads")).toBe(true);
  });
});

describe("the subject never leads with a no-op card (PR2 item 3)", () => {
  const MUST_CATCH = ["Skip the Instagram account check.", "No step needed: Instagram is already connected.", "Dismiss it, you paused this campaign Oct 22."];
  const MUST_NOT_CATCH = ["Raise “Rent a car at $35 per day” from $149 to $178.80 a day.", "Reconnect X Ads", "Skipping the Instagram check for now.", "I'd skip the Instagram check."];
  it.each(MUST_CATCH)("catches %s", (t) => expect(isNoOpLead(t)).toBe(true));
  it.each(MUST_NOT_CATCH)("does not catch %s", (t) => expect(isNoOpLead(t)).toBe(false));
  it("catches a no-op behind a headline label, and the other listed leads", () => {
    expect(isNoOpLead("1 thing needs you. First: Skip the Instagram account check.")).toBe(true);
    expect(isNoOpLead("2 things need you. First: Skip the Instagram account check")).toBe(true);
    expect(isNoOpLead("12 things need you. First: Dismiss it, you paused this campaign Oct 22.")).toBe(true);
    expect(isNoOpLead("2 things need you. First: Reconnect X Ads.")).toBe(false);
    expect(isNoOpLead("Nothing to do on Reddit this week.")).toBe(true);
    expect(isNoOpLead("No action needed: Meta is fine.")).toBe(true);
  });

  const card = (n: number, text: string): NoteItem => ({ section: "needs_you", text, action_id: `a${n}`, channel_slug: "meta_ads" });
  it("deriveHeadline leads with the first card that asks for something; no item is removed", () => {
    const items = buildNoteItems([card(1, MUST_CATCH[0]), card(2, MUST_CATCH[1]), card(3, MUST_NOT_CATCH[0])]);
    expect(items).toHaveLength(3);
    expect(deriveHeadline(items)).toBe("3 things need you. First: Raise “Rent a car at $35 per day” from $149 to $178.80 a day.");
  });
  it("all no-op: keeps the first", () => {
    expect(deriveHeadline(buildNoteItems([card(1, MUST_CATCH[0]), card(2, MUST_CATCH[2])]))).toBe("2 things need you. First: Skip the Instagram account check.");
  });
  it("cgo's own headline that leads with a no-op falls back to deriveHeadline; a good one is kept", () => {
    const items = buildNoteItems([card(1, MUST_CATCH[0]), card(2, MUST_NOT_CATCH[1])]);
    expect(noteHeadline("Skip the Instagram account check this week", items)).toBe("2 things need you. First: Reconnect X Ads.");
    expect(noteHeadline("Reconnect X Ads so your ads keep running", items)).toBe("Reconnect X Ads so your ads keep running");
    expect(noteHeadline("I paused the Reddit campaign today", items)).toBe("2 things need you. First: Reconnect X Ads.");
    expect(noteHeadline(null, items)).toBe("2 things need you. First: Reconnect X Ads.");
    expect(noteHeadline("2 things need you. First: Skip the Instagram account check", items)).toBe("2 things need you. First: Reconnect X Ads.");
  });

  it("the same card twice counts once in the derived headline and the email subject", () => {
    const a = card(1, "Reconnect X Ads");
    const raw = [a, { ...a }];
    expect(deriveHeadline(raw)).toBe("1 thing needs you. First: Reconnect X Ads.");
    const email = renderCgoNoteEmail({ companyName: "Acme", autopilot: true, saw: [], changed: [], need: [], growthUrl: "https://x/g", items: raw });
    expect(email.subject).toBe("Acme: Reconnect X Ads.");
    expect(email.text.split("Reconnect X Ads").length - 1).toBeLessThanOrEqual(2);
  });
});

describe("identical cards fold into one row; no card twice (PR2 item 4)", () => {
  const link = (i: NoteItem) => (i.locations ? `https://x/locations/${i.channel_slug}` : i.action_id ? `https://x/card?id=${i.action_id}` : null);
  const sections = (items: NoteItem[], needsLimit?: number) => noteSections(items, { wouldChange: [], link, moreUrl: "more", ...(needsLimit ? { needsLimit } : {}) });
  const needs = (items: NoteItem[], needsLimit?: number) => sections(items, needsLimit).find((s) => s.key === "needs_you")!.rows;
  const SAME_LINE = "Hold this video. Higgsfield isn't linked, so it can't be made yet";
  const sameCard = (n: number): NoteItem => ({ section: "needs_you", text: SAME_LINE, action_id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, channel_slug: "generated_video", blocker_id: `card:needs_founder:${n}`, blocker_severity: "normal" });

  it("12 identical rows -> one row \"12 cards: ...\" keeping the first card's item and fix", () => {
    const items = Array.from({ length: 12 }, (_, k) => sameCard(k + 1));
    const rows = needs(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(`12 cards: ${SAME_LINE}.`);
    expect(rows[0].item).toBe(items[0]);
    expect(rows[0].url).toBe(`https://x/card?id=${items[0].action_id}`);
    expect(rows[0].fold!.count).toBe(12);
    expect(sections(items).find((s) => s.key === "needs_you")!.more).toBeNull();
    const note = { companyName: "Acme", autopilot: true, saw: [], changed: [], need: [], growthUrl: "https://x/g", items };
    const email = renderCgoNoteEmail(note);
    expect(email.text.split("12 cards:").length - 1).toBe(1);
    expect(email.text.split(`- ${SAME_LINE}`).length - 1).toBe(0);
    expect(email.text).toContain(`12 cards: ${SAME_LINE}`);
    const slack = renderCgoNoteSlack(note);
    expect(slack).toContain(`12 cards: ${SAME_LINE}`);
    expect(email.html).toContain("12 cards: Hold this video.");
  });

  it("the fold never depends on the surface's link: the email's links and reply approval's () => null fold the same rows", () => {
    const urgent: NoteItem = { section: "needs_you", text: "Reconnect TikTok Ads", action_id: "b1", channel_slug: "tiktok_ads", blocker_id: "connector:tiktok_ads", blocker_severity: "urgent" };
    const items = [...Array.from({ length: 12 }, (_, k) => sameCard(k + 1)), urgent, { ...sameCard(20), blocker_id: undefined, locations: true }, { ...sameCard(21), blocker_id: undefined, locations: true }];
    const shape = (link: (i: NoteItem) => string | null) =>
      noteSections(items, { wouldChange: [], link, moreUrl: "more" })
        .find((x) => x.key === "needs_you")!
        .rows.map((r) => [r.line, (r.fold?.items ?? (r.item ? [r.item] : [])).map((i) => i.action_id)]);
    const emailShape = shape((i) => noteRowFix(i, "t-1")?.url ?? null);
    expect(shape(() => null)).toEqual(emailShape);
    expect(emailShape).toHaveLength(3);
    expect(emailShape.map((r) => r[0])).toContain(`12 cards: ${SAME_LINE}.`);
    expect(emailShape.map((r) => r[1])).toContainEqual([sameCard(20).action_id, sameCard(21).action_id]);
  });

  it("two rows with the same action_id -> one", () => {
    const a = sameCard(1);
    expect(needs([a, { ...a }])).toHaveLength(1);
    expect(needs([a, { ...a }])[0].fold).toBeUndefined();
  });

  it("two rows with different fixes, or different urgency, stay two", () => {
    const a = sameCard(1);
    const locations: NoteItem = { ...sameCard(2), blocker_id: undefined, locations: true };
    expect(needs([{ ...a, blocker_id: undefined }, locations])).toHaveLength(2);
    expect(needs([a, { ...sameCard(2), blocker_severity: "urgent" }])).toHaveLength(2);
  });

  it("a duplicate pair where one row is urgent and the other has the fix -> one row that is urgent and has the fix", () => {
    const urgent: NoteItem = { section: "needs_you", text: "Reconnect TikTok Ads", action_id: "a1", channel_slug: "tiktok_ads", blocker_severity: "urgent" };
    const fixed: NoteItem = { section: "needs_you", text: "Reconnect TikTok Ads", action_id: "a1", channel_slug: "tiktok_ads", blocker_id: "connector:tiktok_ads" };
    for (const pair of [[urgent, fixed], [fixed, urgent]]) {
      const rows = needs(pair);
      expect(rows).toHaveLength(1);
      expect(rows[0].item).toMatchObject({ blocker_severity: "urgent", blocker_id: "connector:tiktok_ads" });
    }
    const built = buildNoteItems([urgent, fixed]);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ blocker_severity: "urgent", blocker_id: "connector:tiktok_ads" });
  });
});
