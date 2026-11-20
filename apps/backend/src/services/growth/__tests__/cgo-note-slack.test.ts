import { describe, it, expect } from "vitest";
import { renderCgoNoteSlack } from "../cgo-note-slack";

const url = "https://www.zaviagent.com/workspace?tab=growth-strategy";

describe("the head-of-growth Slack DM", () => {
  it("leads with the one thing, then the call, then what I did, with the check-in, the link and the guarantee line", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI",
      changed: ['Goal "Get 20 signups": target 20 to 12. Behind pace.', "Paused Reddit. Ignored for 9 days."],
      need: ["Connect Google Analytics."],
      nextReviewAt: "2026-10-02T14:00:00Z",
      growthUrl: url,
    });
    expect(text).toBe(
      [
        "*UpcarAI: Connect Google Analytics.*",
        "",
        "*Your call*",
        "• Connect Google Analytics.",
        "",
        "*What I did*",
        '• Goal "Get 20 signups": target 20 to 12. Behind pace.',
        "",
        "• Paused Reddit. Ignored for 9 days.",
        "",
        `Next check-in: Oct 2 · <${url}|Open Growth Strategy>`,
        'Wrong call? Mark it "This was a mistake" there within 30 days and we refund the credits it used.',
      ].join("\n"),
    );
  });

  it("advice only (Autopilot off): no guarantee line, empty sections left out", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], wouldChange: ["Pause Reddit. Ignored."], need: [], nextReviewAt: null, growthUrl: url });
    expect(text).toContain("*What I'd change*\n• Pause Reddit. Ignored.");
    expect(text).not.toContain("What I did");
    expect(text).not.toContain("Your call");
    expect(text).not.toContain("This was a mistake");
    expect(text.endsWith(`<${url}|Open Growth Strategy>`)).toBe(true);
  });

  it("removes personal details the model wrote (cgo reads customer data)", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], need: ["Ask alice@example.com for the conversion report."], growthUrl: url });
    expect(text).not.toContain("alice@example.com");
  });

  it("keeps a growth line about failures and a large grouped goal number intact", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI",
      changed: ['Goal "Reach 1B impressions": target 999,999,999 to 1,000,000,000. The campaign failed 12 times.'],
      need: [],
      growthUrl: url,
    });
    expect(text).toContain('• Goal "Reach 1B impressions": target 999,999,999 to 1,000,000,000. The campaign failed 12 times.');
  });

  it("removes internal artifact ids a prior step's summary carried in", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], need: ["Review artifact d1e8a845 before Friday."], growthUrl: url });
    expect(text).not.toContain("d1e8a845");
  });

  it("escapes Slack control characters in the model's words, so a line cannot forge a link or mention", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], need: ["Reply to <@U123> & check <https://evil.test|this>"], growthUrl: url });
    expect(text).toContain("• Reply to &lt;@U123&gt; &amp; check &lt;https://evil.test|this&gt;");
  });

  it("separates long bullets with a blank line so they do not read as one block", () => {
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], need: ["First ask?", "Second ask?"], growthUrl: url });
    expect(text).toContain("• First ask?\n\n• Second ask?");
  });
});

describe("the check-in footer (R9)", () => {
  const url = "https://www.zaviagent.com/workspace?tab=growth-strategy";
  const note = { companyName: "UpcarAI", changed: [], need: ["x"], nextReviewAt: "2026-10-03T16:00:00.000Z", growthUrl: url };
  it("says the next full check-in and the 2-hourly ad check when cgo runs the ads", () => {
    expect(renderCgoNoteSlack({ ...note, adsEvery2h: true })).toContain(
      `Next full check-in: Oct 3 · I also check your ads every 4 hours during the day · <${url}|Open Growth Strategy>`,
    );
  });
  it("keeps today's footer otherwise", () => {
    const out = renderCgoNoteSlack(note);
    expect(out).toContain(`Next check-in: Oct 3 · <${url}|Open Growth Strategy>`);
    expect(out).not.toContain("every 4 hours");
  });
});

import { renderCgoNoteSlackMessage, SLACK_BLOCK_TEXT_MAX, type SlackNoteQuestion } from "../cgo-note-slack";
import type { NoteItem } from "../cgo-note-items";

describe("a note built from items", () => {
  const T = "73db45ff-457e-4541-bc8f-bdb625390204";
  const base = { companyName: "UpcarAI", changed: [], need: [], nextReviewAt: "2026-10-03T16:00:00.000Z", growthUrl: url, tenantId: T };
  const needs = (id: string, text: string, over: Partial<NoteItem> = {}): NoteItem => ({ section: "needs_you", text, action_id: id, channel_slug: "google_ads", ...over });
  const items: NoteItem[] = [
    needs("a1", "Count sign-ups", { reason: "$468 spent with 0 counted sign-ups" }),
    { section: "changed", text: "Paused Reddit", reason: "Ignored for 9 days", channel_slug: "reddit_organic", undoable: true },
    { section: "working_on", text: "Google Ads: Holding budgets" },
    { section: "blocked", text: "Create YT", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "b1", channel_slug: "youtube_ads" },
  ];

  it("spec section order, headline under the title, a card link on Needs you, refund only with an undoable change", () => {
    const text = renderCgoNoteSlack({ ...base, items, headline: "One fix lets Google see sign-ups." });
    expect(text).toBe(
      [
        "*UpcarAI: One fix lets Google see sign-ups.*",
        "",
        "*Your call*",
        `• Count sign-ups. $468 spent with 0 counted sign-ups. <http://localhost:3000/workspace?tab=channels&channel=google_ads&action=a1&company=${T}|Open>`,
        "",
        "*What I did*",
        "• Paused Reddit. Ignored for 9 days.",
        "",
        "• Google Ads: Holding budgets.",
        "",
        "• Create YT. Google Ads refused this change. We've been alerted; nothing for you to do.",
        "",
        `Next check-in: Oct 3 · <${url}|Open Growth Strategy>`,
        'Wrong call? Mark it "This was a mistake" there within 30 days and we refund the credits it used.',
      ].join("\n"),
    );
    const noUndo = renderCgoNoteSlack({ ...base, items: items.map((i) => ({ ...i, undoable: undefined })) });
    expect(noUndo).not.toContain("This was a mistake");
    expect(noUndo.split("\n")[0]).toBe("*UpcarAI: Count sign-ups.*");
    expect(noUndo.split("\n")[1]).toBe("");
  });

  it("overflow is an explicit N more row that opens the Growth page", () => {
    const many = Array.from({ length: 8 }, (_, i) => needs(`c${i}`, `Card ${i}`, { channel_slug: `ch${i}` }));
    const text = renderCgoNoteSlack({ ...base, items: many });
    expect(text).toContain(`• 3 more on your Growth page. <${url}#growth-needs|Open>`);
    expect(text).toContain("Card 4");
    expect(text).not.toContain("Card 5");
  });

  it("three cards on one channel are one row with ONE button to the channel page", () => {
    const vids = [1, 2, 3].map((k) => needs(`v${k}`, "Founder decides whether to publish this video", { channel_slug: "generated_video", title: `Video ${k}`, ...(k === 1 ? { delivered: true } : {}) }));
    const msg = renderCgoNoteSlackMessage({ ...base, items: vids, tenantId: "t1" });
    const buttons = (msg.blocks as Array<{ accessory?: { url: string; text: { text: string } } }>).flatMap((b) => (b.accessory ? [b.accessory] : []));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].text.text).toBe("Open videos");
    expect(buttons[0].url).toContain("channel=generated_video&company=t1");
    expect(buttons[0].url).not.toContain("action=");
    expect(msg.text).toContain("*3 AI videos are waiting on you*");
    expect(msg.text).toContain("◦ Video 1 · made, not posted yet");
    expect(msg.text).toContain("◦ Video 2 · script only, not made yet");
    expect(msg.text).not.toContain("Founder decides");
  });

  it("a legacy note (no items) renders byte-identical to before", () => {
    const legacy = { companyName: "UpcarAI", changed: ["Paused Reddit. Ignored."], need: ["Connect GA."], nextReviewAt: "2026-10-02T14:00:00Z", growthUrl: url };
    expect(renderCgoNoteSlack({ ...legacy, items: null })).toBe(renderCgoNoteSlack(legacy));
    expect(renderCgoNoteSlack({ ...legacy, items: [] })).toBe(renderCgoNoteSlack(legacy));
    expect(renderCgoNoteSlackMessage({ ...legacy, items: null })).toEqual(renderCgoNoteSlackMessage(legacy));
  });

  it("questions keep the Your calls title, are matched by ordinal, and card rows stay in the same section", () => {
    const q: SlackNoteQuestion = { id: "11111111-1111-4111-8111-111111111111", ordinal: 2, ask: "Keep Reddit?", recommended: "yes", why: null, yesNo: true, noteLine: "a DIFFERENT stored line" };
    const withQ: NoteItem[] = [{ section: "needs_you", text: "Keep Reddit? If you don't answer by Oct 3, I'll pause it.", question_ordinal: 2 }, needs("a1", "Count sign-ups")];
    const msg = renderCgoNoteSlackMessage({ ...base, items: withQ, questions: [q] });
    const texts = (msg.blocks as Array<{ type: string; text?: { text: string }; elements?: Array<{ text?: string; action_id?: string }> }>);
    const joined = texts.map((b) => b.text?.text ?? b.elements?.map((e) => e.text ?? e.action_id).join(" ") ?? "").join("\n");
    expect(joined).toContain("*Your calls*");
    expect(joined).not.toContain("What I need from you");
    expect(joined).toContain("*2. Keep Reddit?*");
    expect(JSON.stringify(msg.blocks)).toContain("cgo_q:11111111-1111-4111-8111-111111111111:yes");
    const qAt = texts.findIndex((b) => b.type === "actions");
    const cardAt = texts.findIndex((b, i) => i > 0 && b.text?.text.includes("Count sign-ups"));
    const titleAt = texts.findIndex((b) => b.text?.text.includes("*Your calls*"));
    expect(titleAt).toBeLessThan(qAt);
    expect(cardAt).toBeGreaterThan(qAt);
    expect(msg.text).toContain("2. Keep Reddit?");
    expect(msg.text).toContain("Count sign-ups");
  });

  it("a question row with no open question left renders as its line (no buttons)", () => {
    const msg = renderCgoNoteSlackMessage({ ...base, items: [{ section: "needs_you", text: "Keep Reddit?", question_ordinal: 4 }], questions: [] });
    expect((msg.blocks as Array<{ type: string }>).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(msg.blocks)).toContain("Keep Reddit?");
  });

  it("with 60 long items every block fits and nothing is truncated", () => {
    const long = "word ".repeat(70).trim();
    const sixty: NoteItem[] = Array.from({ length: 60 }, (_, i) => ({
      section: (["needs_you", "changed", "working_on", "blocked"] as const)[i % 4],
      text: `Item ${i}`,
      reason: `${long} end${i}`,
      ...(i % 4 === 0 ? { action_id: `x${i}`, channel_slug: "seo" } : {}),
    }));
    const msg = renderCgoNoteSlackMessage({ ...base, items: sixty, headline: "h".repeat(120) });
    const blocks = msg.blocks as Array<{ type: string; text?: { text: string }; elements?: Array<{ text?: string }> }>;
    const texts = blocks.map((b) => b.text?.text ?? b.elements?.map((e) => e.text ?? "").join("") ?? "");
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(SLACK_BLOCK_TEXT_MAX);
    expect(blocks.length).toBeLessThanOrEqual(50);
    const all = texts.join("\n");
    for (const line of msg.text.split("\n").filter((l) => l.startsWith("• "))) expect(all).toContain(line.slice(2).replace(/ <[^>]*\|Open>$/, ""));
    expect(all).toContain("more on your Growth page.");
  });

  it("a single row longer than a block is split on a word boundary, not cut", () => {
    const huge: NoteItem[] = [{ section: "working_on", text: "Big", reason: "word ".repeat(700).trim() }];
    const msg = renderCgoNoteSlackMessage({ ...base, items: huge });
    const texts = (msg.blocks as Array<{ type: string; text?: { text: string } }>).filter((b) => b.type === "section").map((b) => b.text!.text);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(SLACK_BLOCK_TEXT_MAX);
    expect(texts.join(" ").match(/word/g)!.length).toBe(700);
  });

  it("escapes the model's words but never the links it built", () => {
    const text = renderCgoNoteSlack({ ...base, items: [needs("a1", "Reply to <@U123> & check")] });
    expect(text).toContain("*UpcarAI: Reply to &lt;@U123&gt; &amp; check.*");
    expect(text).toContain("<http://localhost:3000/workspace?tab=channels&channel=google_ads&action=a1&company=");
    expect(text).not.toContain("<@U123>");
  });
});

import { plansUrl } from "@/services/web-base";

describe("the plan line in Slack", () => {
  it("links to the plans page as See plans, and is never the headline", () => {
    const items: NoteItem[] = [{ section: "working_on", text: "To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have", plans: true }];
    const text = renderCgoNoteSlack({ companyName: "UpcarAI", changed: [], need: [], growthUrl: url, tenantId: "t-1", items });
    expect(text).toContain(`To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have. <${plansUrl()}|See plans>`);
    expect(text.split("\n")[0]).toBe("*UpcarAI: your head of growth update*");
    const blocks = JSON.stringify(renderCgoNoteSlackMessage({ companyName: "UpcarAI", changed: [], need: [], growthUrl: url, tenantId: "t-1", items }).blocks);
    expect(blocks).toContain(`"text":{"type":"plain_text","text":"See plans"},"url":"${plansUrl()}"`);
    expect(plansUrl()).toMatch(/\/pricing$/);
  });
});

describe("a direct alert (kind alarm) with no items: no check-in footer, as in the email (2026-10-29)", () => {
  const ask = "I did not cut “Regular Leads - Ad set” from $100 to $80 a day on my own: you changed its budget in Ads Manager on Oct 11; conversion tracking is not working. Should I apply it?";
  const q: SlackNoteQuestion = { id: "q-cut", ordinal: 1, ask, recommended: null, why: null, yesNo: true, noteLine: ask };
  const alarm = { companyName: "UpcarAI", kind: "alarm", changed: [], need: [ask], nextReviewAt: "2026-10-30T14:00:00Z", growthUrl: url, adsEvery2h: true, questions: [q] };

  it("the DM keeps the call with its case and its link, without the check-in line", () => {
    const msg = renderCgoNoteSlackMessage(alarm);
    const all = `${msg.text}\n${JSON.stringify(msg.blocks)}`;
    expect(all).not.toMatch(/check-in|every 4 hours/);
    expect(msg.text).toContain("*1. Cut “Regular Leads - Ad set” from $100 to $80 a day?*");
    expect(msg.text).toContain("If you say no: it stays at $100 a day.");
    expect(JSON.stringify(msg.blocks)).toContain("q-cut");
    expect(JSON.stringify(msg.blocks.at(-1))).toContain("Open Growth Strategy");
    expect(JSON.stringify(msg.blocks[0])).toContain("UpcarAI: Cut “Regular Leads - Ad set” to $80 a day?");
  });

  it("must-not: a check-in note (not an alarm) keeps its check-in line", () => {
    const msg = renderCgoNoteSlackMessage({ ...alarm, kind: "review" });
    expect(JSON.stringify(msg.blocks.at(-1))).toContain("Next full check-in: Oct 30 · I also check your ads every 4 hours during the day");
  });
});
