import { describe, it, expect } from "vitest";
import { renderCgoNoteEmail } from "../cgo-note";
import { noteGoalViews, isGoalSawLine, sawLines, questionNoteLine, autoRunLine, cutKeepingQuestion, type GoalRow } from "@/services/growth/goal-owner";

describe("renderCgoNoteEmail", () => {
  const url = "https://www.zaviagent.com/workspace?tab=growth-strategy&company=t-1";
  const base = { companyName: "UpcarAI", autopilot: true, growthUrl: url };

  it("leads with the call, then what I did (changes, then what I saw); skips an empty section", () => {
    const r = renderCgoNoteEmail({
      ...base,
      saw: ["9 Reddit posts have waited 9 days."],
      changed: ["Paused Reddit. 9 posts untouched for 9 days."],
      need: ["Is 150 renters a week right?"],
      canReply: true,
    });
    expect(r.subject).toBe("UpcarAI: Is 150 renters a week right?");
    expect(r.text.indexOf("Your call")).toBeLessThan(r.text.indexOf("What I did"));
    expect(r.text).toContain("What I did\n- Paused Reddit. 9 posts untouched for 9 days.\n- 9 Reddit posts have waited 9 days.");
    expect(r.text).not.toContain("What I'd change");
    expect(r.html).toContain(">II<");
    const ask = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: ["Paid trips run 16 a week. Keep 150?"] });
    expect(ask.html).toMatch(/Paid trips run 16 a week\. <strong[^>]*>Keep 150\?<\/strong>/);
    expect(r.html).toContain(">Paused Reddit.<");
    expect(r.html).toContain(url);
    expect(r.text).toContain("Just reply to this email");
    expect(r.html).toContain("Just reply to this email");
  });

  it("never asks for a reply when no inbox routes it to cgo", () => {
    const q = { ordinal: 1, ask: "Which goal should this track?", recommended: null, why: null, yesHref: null, noHref: null };
    const r = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], questions: [q], canReply: false });
    for (const out of [r.text, r.html]) {
      expect(out).not.toContain("Just reply to this email");
      expect(out).not.toContain("Reply in your own words.");
    }
    const items = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], canReply: false, items: [{ section: "needs_you", text: "x", question_ordinal: 1 }], questions: [q] });
    for (const out of [items.text, items.html]) {
      expect(out).not.toContain("Just reply to this email");
      expect(out).not.toContain("Reply in your own words.");
    }
    const replyable = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], canReply: true, items: [{ section: "needs_you", text: "x", question_ordinal: 1 }], questions: [q] });
    expect(replyable.text).toContain("Just reply to this email");
    expect(replyable.html).toContain("Reply in your own words.");
  });

  it("names the company in the subject, the heading and the text, so an owner of several can tell them apart", () => {
    const r = renderCgoNoteEmail({ ...base, companyName: "Private Rents", autopilot: false, saw: ["On pace."], changed: [], need: [] });
    expect(r.subject).toBe("Private Rents: your weekly growth note");
    expect(r.html).toContain("Private Rents: here is where things");
    expect(r.text.startsWith("Private Rents: here is where things stand")).toBe(true);
  });

  it("Autopilot on with nothing changed drops 'weekly' (its check-ins are 2-14 days)", () => {
    const r = renderCgoNoteEmail({ ...base, saw: ["On pace."], changed: [], need: [] });
    expect(r.subject).toBe("UpcarAI: your growth note");
  });

  it("Autopilot off: the subject is the first idea, never a count", () => {
    const r = renderCgoNoteEmail({ ...base, autopilot: false, saw: [], changed: [], wouldChange: ["Pause X.", "Raise Y."], need: [] });
    expect(r.subject).toBe("UpcarAI: Pause X.");
    expect(r.text).toContain("What I'd change\n- Pause X.\n- Raise Y.");
  });

  it("says where each goal stands and drops its saw line, keeping the rest", () => {
    const goalLine = "Lift first-booking rate to 20%: No number yet for activation rate (target 20), 94 days left.";
    const r = renderCgoNoteEmail({
      ...base,
      saw: [goalLine, "5 Google Ads cards waiting for you, the oldest for 7 days."],
      changed: [],
      need: ["Is 150 right?"],
      goals: [
        { title: "Lift first-booking rate to 20%", current: null, target: "target 20", progress: null, due: "94 days left", pace: null },
        { title: "Signups", current: "6 of 20 signups", target: "target 20", progress: 0.3, due: "12 days left", pace: "on pace for about 18 by Oct 10" },
      ],
      goalSawLines: [goalLine],
    });
    expect(r.html).not.toContain("No number yet");
    expect(r.html).toContain("5 Google Ads cards waiting");
    expect(r.html).not.toContain("activation rate (target 20)");
    expect(r.text).toContain("Where you stand\n- Your aim: Lift first-booking rate to 20%. Not counted yet.");
    expect(r.text).toContain("- Signups: 6 of 20 signups, 12 days left.");
  });

  it("escapes model text and the company name in HTML", () => {
    const r = renderCgoNoteEmail({
      ...base,
      companyName: "<b>Acme</b>",
      saw: ["<script>x</script>"],
      changed: [],
      need: ["<img src=x>"],
      goals: [{ title: "<i>g</i>", current: null, target: null, progress: null, due: null, pace: null }],
    });
    expect(r.html).not.toContain("<script>x</script>");
    expect(r.html).not.toContain("<b>Acme</b>");
    expect(r.html).not.toContain("<img src=x>");
    expect(r.html).not.toContain("<i>g</i>");
  });
});

describe("note helpers", () => {
  const today = "2026-09-28";
  const goal = (over: Partial<GoalRow>): GoalRow => ({
    id: "g",
    objective: "Grow signups",
    target_metric: "signups",
    target_value: 20,
    current_value: null,
    due_date: "2026-10-10",
    status: "active",
    priority: 1,
    measurement_mode: "manual",
    current_value_at: `${today}T00:00:00Z`,
    ...over,
  });

  it("noteGoalViews: empty bar with no number, a fraction toward target with one, lower-is-better filling downward", () => {
    const [none] = noteGoalViews([goal({})], today);
    expect(none).toMatchObject({ current: null, progress: null, due: "12 days left", target: "target 20" });
    const [some] = noteGoalViews([goal({ current_value: 5 })], today);
    expect(some.progress).toBe(0.25);
    expect(some.current).toBe("5 of 20 signups");
    const [cost] = noteGoalViews([goal({ target_metric: "cac", baseline_value: 100, target_value: 50, current_value: 75 })], today);
    expect(cost.progress).toBe(0.5);
    const [undated] = noteGoalViews([goal({ current_value: 5, current_value_at: null })], today);
    expect(undated.progress).toBeNull();
  });

  it("noteGoalViews: at most two, skipping goals that are over", () => {
    const views = noteGoalViews(
      [goal({ objective: "a", due_date: "2026-01-01" }), goal({ objective: "b" }), goal({ objective: "c" }), goal({ objective: "d" })],
      today,
    );
    expect(views.map((v) => v.title)).toEqual(["b", "c"]);
  });

  it("a goal named with a trailing period reads 'GMV growth stunt: $170,000 of $300,000 GMV', and its saw line is still dropped", () => {
    const g = goal({ objective: "GMV growth stunt.", target_metric: "gmv", target_value: 300000, current_value: 170000, due_date: "2026-10-31" });
    const saw = sawLines([g], [], { days_since_active: 0 } as Parameters<typeof sawLines>[2], today);
    expect(saw[0].startsWith("GMV growth stunt: $170,000 of $300,000 GMV")).toBe(true);
    const views = noteGoalViews([g], today);
    const r = renderCgoNoteEmail({ companyName: "UpcarAI", autopilot: true, growthUrl: "u", saw, changed: [], need: [], goals: views, goalSawLines: saw.filter((l) => isGoalSawLine(l, [g])) });
    expect(r.text).toContain("- GMV growth stunt: $170,000 of $300,000 GMV");
    expect(r.text).not.toContain(".:");
    expect(r.text).not.toContain("gmv");
    expect(isGoalSawLine("GMV growth stunt.: 170,000 of 300,000 gmv.", [g])).toBe(true);
  });

  it("isGoalSawLine matches the line sawLines wrote for a goal", () => {
    expect(isGoalSawLine("Grow signups: 5 of 20 signups.", [goal({})])).toBe(true);
    expect(isGoalSawLine("5 Reddit cards waiting.", [goal({})])).toBe(false);
  });

  it("a long ask never loses its default: the action that runs on silence", () => {
    const ask = `${"Paid first trips were 15, 9, 10 and 14 a week. ".repeat(12)}Should I change the target to 24?`;
    const line = questionNoteLine(ask, "If I don't hear back by Friday, I'll pause Meta Ads.");
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith("Should I change the target to 24? If I don't hear back by Friday, I'll pause Meta Ads.")).toBe(true);
  });

  it("noteGoalViews: a stale automatic number gets no bar and says how old it is", () => {
    const [v] = noteGoalViews([goal({ current_value: 20, measurement_mode: "auto", current_value_at: "2026-09-01T00:00:00Z" })], today);
    expect(v.progress).toBeNull();
    expect(v.current).toBe("20 of 20 signups, last measured 27 days ago");
  });

  it("isGoalSawLine matches a goal this review renamed, by its old name", () => {
    const renamed = [goal({ objective: "Grow hosts to 800 by Dec 31" })];
    const changed = ['Goal "Grow hosts to 800 by September": now "Grow hosts to 800 by Dec 31". Wording only.'];
    expect(isGoalSawLine("Grow hosts to 800 by September: 612 of 800 hosts.", renamed, changed)).toBe(true);
    expect(isGoalSawLine("Grow hosts to 800 by September: 612 of 800 hosts.", renamed)).toBe(false);
  });

  it("questionNoteLine cuts at a whole word, never mid-word", () => {
    const line = questionNoteLine("word ".repeat(100).trim(), null);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith("word…")).toBe(true);
  });

  it("a long ask keeps its closing question whole and cuts the context before it", () => {
    const ask = `${"Paid first trips were 15, 9, 10 and 14 a week. ".repeat(12)}Should I change the target to 24 a week, or keep 150?`;
    const line = questionNoteLine(ask, null);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith("Should I change the target to 24 a week, or keep 150?")).toBe(true);
    expect(line).toContain("… Should I");
    expect(cutKeepingQuestion("word ".repeat(100), 50).endsWith("word…")).toBe(true);
  });

  it("autoRunLine names the channel, not its slug", () => {
    expect(autoRunLine("meta_ads", "Pause the awareness campaign")).toBe("Started Meta Ads: Pause the awareness campaign");
    expect(autoRunLine("research", "price the rivals")).toBe("Started research: price the rivals");
  });
});

describe("the subject never counts", () => {
  it("'Left for you' cards: the subject is the first one, never '2 left for you'", () => {
    const r = renderCgoNoteEmail({
      companyName: "UpcarAI",
      autopilot: true,
      saw: [],
      changed: [],
      need: ["Left for you: Pause \u201cAwareness\u201d, because it is still running.", "Left for you: Approve the Awareness pause, because it waits."],
      growthUrl: "https://x",
    });
    expect(r.subject).toBe("UpcarAI: Left for you: Pause \u201cAwareness\u201d, because it is still running.");
  });
});

describe("renderCgoNoteEmail: the check-in footer (R9)", () => {
  const base = { companyName: "UpcarAI", autopilot: true, growthUrl: "https://x", saw: [], changed: [], need: ["x"], nextReviewAt: "2026-10-03T16:00:00.000Z" };
  it("says the next full check-in and the 2-hourly ad check when cgo runs the ads", () => {
    const r = renderCgoNoteEmail({ ...base, adsEvery2h: true });
    expect(r.text).toContain("Next full check-in: Oct 3 · I also check your ads every 4 hours during the day");
    expect(r.html).toContain("Next full check-in: Oct 3 · I also check your ads every 4 hours during the day");
  });
  it("keeps the plain check-in otherwise, in one voice", () => {
    const r = renderCgoNoteEmail(base);
    expect(r.text).not.toContain("every 4 hours");
    expect(r.text).toContain("Next check-in: Oct 3.");
    expect(r.html).toContain("I write after each check-in on your goals");
  });
});

import { EMAIL_REFUND_LINE } from "../cgo-note";
import type { NoteItem } from "@/services/growth/cgo-note-items";

describe("renderCgoNoteEmail: a note built from items", () => {
  const url = "https://www.zaviagent.com/workspace?tab=growth-strategy&company=t-1";
  const base = { companyName: "UpcarAI", autopilot: true, growthUrl: url, saw: [], changed: [], need: [], tenantId: "t-1" };
  const items: NoteItem[] = [
    { section: "needs_you", text: "Count sign-ups", reason: "$468 spent with 0 counted sign-ups", action_id: "a1", channel_slug: "google_ads" },
    { section: "changed", text: "Paused Reddit", reason: "Ignored for 9 days", channel_slug: "reddit_organic", undoable: true },
    { section: "working_on", text: "Google Ads: Holding budgets" },
    { section: "blocked", text: "Create YT", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "b1", channel_slug: "youtube_ads" },
  ];

  it("a note holding one question and nothing else is subjected by that question, so two such notes differ", () => {
    const q = (ask: string) => ({ ordinal: 1, ask, recommended: "yes" as const, why: null, yesHref: null, noHref: null });
    const raise = q('I did not apply "Raise “Rent a car at $35 per day” (ad set 120258729006520059) from $149 to $178.80 a day" on my own: you set its budget yourself in the last 30 days. Should I apply it?');
    const pause = q("Pause TikTok while the pixel is down?");
    const one = (x: ReturnType<typeof q>) => renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], questions: [x] }).subject;
    expect(one(pause)).toBe("UpcarAI: Pause TikTok while the pixel is down?");
    const long = one(raise);
    expect(long).not.toBe(one(pause));
    expect(long).toBe('UpcarAI: Apply "Raise “Rent a car at $35 per day” from $149 to $178.80 a day"?');
    expect(long.length).toBeLessThanOrEqual("UpcarAI: ".length + 80);
    const viaItems = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], questions: [pause], items: [{ section: "needs_you", text: pause.ask, question_ordinal: 1 }] });
    expect(viaItems.subject).toBe("UpcarAI: Pause TikTok while the pixel is down?");
    expect(renderCgoNoteEmail({ ...base, saw: [], changed: ["Paused Reddit."], need: [], questions: [pause] }).subject).toBe("UpcarAI: Pause TikTok while the pixel is down?");
    expect(renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], questions: [pause, { ...pause, ordinal: 2 }] }).subject).toBe("UpcarAI: Pause TikTok while the pixel is down?");
  });

  it("subject is the headline; derived when missing", () => {
    expect(renderCgoNoteEmail({ ...base, items, headline: "One fix lets Google see sign-ups." }).subject).toBe("UpcarAI: One fix lets Google see sign-ups.");
    expect(renderCgoNoteEmail({ ...base, items }).subject).toBe("UpcarAI: Count sign-ups.");
  });

  it("same sections and order as Slack; card rows link to the card; overflow links to the Growth page", () => {
    const many: NoteItem[] = [...items, ...Array.from({ length: 6 }, (_, i) => ({ section: "needs_you" as const, text: `Card ${i}`, action_id: `c${i}`, channel_slug: `seo${i}` }))];
    const r = renderCgoNoteEmail({ ...base, items: many });
    const at = (t: string) => r.text.indexOf(`\n${t}\n`);
    expect(at("Your calls")).toBeGreaterThan(0);
    expect(at("Your calls")).toBeLessThan(at("What I did"));
    expect(r.text).toContain("- $468 spent with 0 counted sign-ups. Open: http://localhost:3000/workspace?tab=channels&channel=google_ads&action=a1&company=t-1");
    expect(r.html).toContain("action=a1&amp;company=t-1");
    expect(r.text).toContain(`- 2 more on your Growth page. ${url}`);
    expect(r.html).toContain("2 more on your Growth page.");
    expect(r.text).toContain("What I did\n- Paused Reddit. Ignored for 9 days.\n- Google Ads: Holding budgets.\n- Create YT. Google Ads refused this change. We've been alerted; nothing for you to do.\n");
  });

  it("the refund line only with an undoable change", () => {
    expect(renderCgoNoteEmail({ ...base, items }).text).toContain(EMAIL_REFUND_LINE);
    const none = renderCgoNoteEmail({ ...base, items: items.map((i) => ({ ...i, undoable: undefined })) });
    expect(none.text).not.toContain("This was a mistake");
    expect(none.html).not.toContain("This was a mistake");
  });

  it("questions are matched by ordinal and keep their one-tap buttons", () => {
    const r = renderCgoNoteEmail({
      ...base,
      items: [{ section: "needs_you", text: "stored line differs", question_ordinal: 1 }, items[0]],
      questions: [{ ordinal: 1, ask: "Keep Reddit?", recommended: "yes", why: null, yesHref: "mailto:a?body=1%20yes", noHref: "mailto:a?body=1%20no" }],
    });
    expect(r.html).toContain("1. Keep Reddit?");
    expect(r.html).toContain("mailto:a?body=1%20yes");
    expect(r.text).toContain("- 1. Keep Reddit? (I recommend: Yes)");
    expect(r.text).not.toContain("stored line differs");
  });

  it("a claim about the founder's own records: neither button is the default, and 'yes to all' is not offered", () => {
    const q = { ordinal: 1, ask: "Is this true for your business: Hosts cancel paid bookings?", recommended: null, why: null, yesHref: "mailto:a?body=1%20yes", noHref: "mailto:a?body=1%20no" };
    const plain = renderCgoNoteEmail({ ...base, items: [{ section: "needs_you", text: "x", question_ordinal: 1 }], questions: [q] });
    const fact = renderCgoNoteEmail({ ...base, items: [{ section: "needs_you", text: "x", question_ordinal: 1 }], questions: [{ ...q, factCheck: true }] });
    expect((plain.html.match(/;color:#FFFFFF;/g) ?? []).length).toBe(1);
    expect(fact.html).not.toMatch(/;color:#FFFFFF;/);
    expect(plain.text).toContain("Or reply with `1 yes`.");
    const q2 = { ...q, ordinal: 2, yesHref: "mailto:a?body=2%20yes", noHref: "mailto:a?body=2%20no" };
    const two = (fc: boolean) =>
      renderCgoNoteEmail({ ...base, items: [{ section: "needs_you", text: "x", question_ordinal: 1 }, { section: "needs_you", text: "y", question_ordinal: 2 }], questions: [{ ...q, factCheck: fc }, q2] });
    expect(two(false).text).toContain("or just `yes` to all");
    expect(two(true).text).not.toContain("yes` to all");
    expect(two(true).text).toContain("Or reply with `1 yes, 2 no`.");
  });

  describe("one reply hint, built from the ordinals the email prints", () => {
    const q = (ordinal: number) => ({ ordinal, ask: `Question ${ordinal}?`, recommended: "yes" as const, why: null, yesHref: `mailto:a?body=${ordinal}%20yes`, noHref: `mailto:a?body=${ordinal}%20no` });
    const row = (ordinal: number) => ({ section: "needs_you" as const, text: `Question ${ordinal}?`, question_ordinal: ordinal });
    const hints = (s: string) => (s.match(/Or reply with/g) ?? []).length;

    it("an email showing only ordinal 2 -> one hint, `2 yes`, never `1 yes`", () => {
      const r = renderCgoNoteEmail({ ...base, items: [row(2)], questions: [q(1), q(2)] });
      for (const out of [r.text, r.html]) {
        expect(hints(out)).toBe(1);
        expect(out).toContain("`2 yes`");
        expect(out).not.toContain("1 yes");
      }
    });

    it("an email with questions 2 and 5 -> one hint `2 yes, 5 no`", () => {
      const r = renderCgoNoteEmail({ ...base, items: [row(2), { section: "needs_you", text: "Reconnect X Ads" }, row(5)], questions: [q(2), q(5)] });
      for (const out of [r.text, r.html]) {
        expect(hints(out)).toBe(1);
        expect(out).toContain("`2 yes, 5 no`");
        expect(out).not.toContain("1 yes");
      }
      expect(r.html.indexOf("Or reply with")).toBeGreaterThan(r.html.indexOf("5. Question 5?"));
    });

    it("the legacy text path builds the hint the same way", () => {
      const r = renderCgoNoteEmail({ ...base, saw: [], changed: [], need: [], questions: [q(3)] });
      expect(hints(r.text)).toBe(1);
      expect(hints(r.html)).toBe(1);
      expect(r.text).toContain("Or reply with `3 yes`.");
    });
  });

  it("a legacy note (no items) is unchanged", () => {
    const legacy = { ...base, changed: ["Paused Reddit. Ignored."], need: ["Is 150 right?"] };
    expect(renderCgoNoteEmail({ ...legacy, items: null })).toEqual(renderCgoNoteEmail(legacy));
    expect(renderCgoNoteEmail({ ...legacy, items: [] })).toEqual(renderCgoNoteEmail(legacy));
  });
});

import { plansUrl } from "@/services/web-base";

describe("renderCgoNoteEmail: the plan line", () => {
  it("keeps its See plans link in the html and the text, and is never the subject", () => {
    const items: NoteItem[] = [
      { section: "working_on", text: "To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have", plans: true },
      { section: "working_on", text: "Research: count cancelled trips" },
    ];
    const r = renderCgoNoteEmail({ companyName: "UpcarAI", autopilot: true, growthUrl: "https://www.zaviagent.com/workspace", saw: [], changed: [], need: [], tenantId: "t-1", items });
    expect(r.subject).toBe("UpcarAI: Working on Research: count cancelled trips.");
    expect(r.html).toMatch(/channels you have\. <a href="[^"]*\/pricing"[^>]*>See plans<\/a><\/div>/);
    expect(r.text).toContain(`- To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have. See plans: ${plansUrl()}`);
    expect(r.text).toContain("- Research: count cancelled trips.\n");
  });
});
