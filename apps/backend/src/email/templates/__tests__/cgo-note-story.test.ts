import { describe, it, expect } from "vitest";
import { renderCgoNoteEmail } from "../cgo-note";
import { noteGoalViews, type GoalRow } from "@/services/growth/goal-owner";
import { heldChangeAsk, heldChangePhrase } from "@/services/growth/unattended-policy";
import { noteLead, noteWorthSending, parseHeldAsk } from "@/services/growth/cgo-note-story";
import { validHeadline, type NoteItem } from "@/services/growth/cgo-note-items";
import { renderCgoNoteSlack, renderCgoNoteSlackMessage } from "@/services/growth/cgo-note-slack";

const URL = "https://www.zaviagent.com/workspace?tab=growth-strategy&company=73db45ff";
const NOW = new Date("2026-10-29T18:00:00Z");
const RAVI_ASK =
  "I did not raise “Rent a car at $35 per day” from $178.80 to $214.56 a day on my own: Zavi already raised this budget in the last 24 hours. Should I apply it?";

const gmv: GoalRow = {
  id: "g1",
  objective: "GMV growth stunt",
  target_metric: "gmv",
  target_value: 300000,
  current_value: 270000,
  current_value_at: "2026-10-28T12:00:00Z",
  baseline_value: 0,
  created_at: "2026-10-01T00:00:00Z",
  due_date: "2026-10-31",
  status: "active",
  priority: 1,
  measurement_mode: "manual",
};
const goalView = { ...noteGoalViews([gmv], "2026-10-29")[0], pace: "on pace for about 298,929 by Oct 31", verdict: "GMV is on pace for about 298,929 by Oct 31: about 1,071 short of 300,000, 2 days left.", tone: "short" as const };

const solidCount = (html: string) => (html.match(/color:#FFFFFF;/g) ?? []).length + (html.match(/color:#ffffff;text-decoration:none/g) ?? []).length;

describe("Ravi's real held-raise email (legacy alarm note)", () => {
  const q = { ordinal: 1, ask: RAVI_ASK, recommended: null, why: null, yesHref: "mailto:a?body=1%20yes", noHref: "mailto:a?body=1%20no" };
  const r = renderCgoNoteEmail({
    companyName: "UpcarAI", autopilot: true, adsEvery2h: true, canReply: true, growthUrl: URL, tenantId: "73db45ff",
    saw: [], changed: [], need: [RAVI_ASK], kind: "alarm", goals: [goalView], questions: [q], now: NOW,
  });

  it("is subjected by the decision, never a count", () => {
    expect(r.subject).toBe("UpcarAI: Raise “Rent a car at $35 per day” to $214.56 a day?");
    expect(r.subject).not.toMatch(/\b1 question\b/);
  });
  it("draws no stat pills", () => {
    expect(r.html).not.toContain("needs you<");
    expect(r.html).not.toContain("changes made");
    expect(r.html).not.toContain("goals tracked");
  });
  it("says where the founder stands, with the source of the number", () => {
    expect(r.html).toContain("about 1,071 short");
    expect(r.html).toContain("From the $270,000 you entered Oct 28.");
  });
  it("draws a decision card with the cost, my recommendation and what stays", () => {
    expect(r.html).toContain("Raise “Rent a car at $35 per day” from $178.80 to $214.56 a day?");
    expect(r.html).toContain("+$35.76 a day, about $107 more by Oct 31.");
    expect(r.html).toContain("I recommend: Yes.");
    expect(r.html).toContain("If you say no: it stays at $178.80 a day.");
    expect(r.html).toContain("or <a");
    expect(r.html).toContain("No, keep $178.80");
  });
  it("has exactly one solid button, and the bottom is a quiet link", () => {
    expect(solidCount(r.html)).toBe(1);
    expect(r.html).toContain("Open your Growth page →");
  });
  it("keeps the numbered question line the reply path matches, and the one hint", () => {
    expect(r.text).toContain(`- 1. ${RAVI_ASK} (I recommend: Yes)`);
    expect(r.text).toContain("Or reply with `1 yes`.");
  });
  it("an alarm says nothing about the next check-in", () => {
    expect(r.text).not.toContain("check-in");
  });
});

describe("parseHeldAsk", () => {
  it("reads back every budget sentence heldChangeAsk writes", () => {
    const what = heldChangePhrase("meta_ads.update_budget", { daily_budget_usd: 214.56, expected_current_daily_budget_usd: 178.8 }, null, "Rent a car at $35 per day");
    const ask = heldChangeAsk(what, ["raised_in_last_day"], "Last 7 days (read Oct 28): $376.35 spent, 10 conversions; judged on purchases.", false);
    const d = parseHeldAsk(ask, NOW)!;
    expect(d.title).toBe("Raise “Rent a car at $35 per day” from $178.80 to $214.56 a day?");
    expect(d.lastNumbers).toBe("Last 7 days (read Oct 28): $376.35 spent, 10 conversions; judged on purchases.");
    expect(d.heldBecause).toBe("I already raised this budget in the last 24 hours.");
    expect(d.recommend).toBe("yes");
  });
  it("recommends No when the cap warning applies, for the same reason", () => {
    const ask = heldChangeAsk("raise “X” from $100 to $120 a day", ["raised_in_last_day"], null, false, undefined, "This puts you on track for $29,225.70 this month, $825.70 over your $28,400 cap");
    const d = parseHeldAsk(ask, NOW)!;
    expect(d.recommend).toBe("no");
    expect(d.why).toBe("Same reason I'd hold it: this puts you on track for $29,225.70 this month, $825.70 over your $28,400 cap.");
  });
  it("prices a cut as savings, and never invents what it does not carry", () => {
    const d = parseHeldAsk("I did not cut “Leads” from $100 to $80 a day on my own: you set its budget yourself. Should I apply it?", NOW)!;
    expect(d.cost).toBe("Saves $20 a day, about $60 by Oct 31.");
    expect(d.lastNumbers).toBeNull();
    expect(parseHeldAsk("Should I pause TikTok?", NOW)).toBeNull();
  });
});

describe("the one thing", () => {
  it("a count-only headline is never the subject, and cgo cannot write one", () => {
    expect(validHeadline("2 things need you")).toBeNull();
    expect(validHeadline("1 question, 1 change")).toBeNull();
    expect(validHeadline("One fix lets Google see sign-ups.")).toBe("One fix lets Google see sign-ups.");
    expect(noteLead({ headline: "1 thing needs you. First: Count sign-ups.", firstAsk: null })).toBe("Count sign-ups.");
    expect(noteLead({ headline: "2 questions for you.", firstAsk: "Pause TikTok while the pixel is down?" })).toBe("Pause TikTok while the pixel is down?");
  });
});

describe("where you stand", () => {
  it("review F1: a lower-is-better goal behind its target reads 'over your target', never 'short of'", () => {
    const cac: GoalRow = { ...gmv, objective: "Cut CAC", target_metric: "cac", baseline_value: 100, target_value: 50, current_value: 80, current_value_at: "2026-10-28T12:00:00Z" };
    const v = noteGoalViews([cac], "2026-10-29")[0];
    expect(v.verdict ?? "").not.toMatch(/short of/);
    if (v.verdict && v.tone === "short") expect(v.verdict).toMatch(/over your \$50 target/);
  });
  it("no pace: the aim in neutral grey, never red, never 'No number yet'", () => {
    const v = noteGoalViews([{ ...gmv, current_value: null, current_value_at: null }], "2026-10-29")[0];
    const r = renderCgoNoteEmail({ companyName: "Co", autopilot: true, growthUrl: URL, saw: [], changed: ["Paused Reddit."], need: [], goals: [v] });
    expect(r.text).toContain("Your aim: $300,000 GMV by Oct 31. Not counted yet.");
    expect(r.html).not.toContain("No number yet");
    expect(r.html).not.toContain("#B3261E");
  });
  it("shows the founder's own estimate under the aim when piece 3 sends one", () => {
    const v = { ...noteGoalViews([{ ...gmv, current_value: null }], "2026-10-29")[0], founder_estimate: "You told me 6-20 new customers last month" };
    const r = renderCgoNoteEmail({ companyName: "Co", autopilot: true, growthUrl: URL, saw: [], changed: ["Paused Reddit."], need: [], goals: [v] });
    expect(r.html).toContain("You told me 6-20 new customers last month");
  });
});

describe("what I did and the bottom button", () => {
  it("a note with only results keeps ONE solid bottom button and lists the proof", () => {
    const items: NoteItem[] = [
      { section: "changed", text: "Applied: Cut “Leads” from $100 to $80 a day", channel_slug: "meta_ads" },
      { section: "working_on", text: "Drafted 3 Reddit posts" },
    ];
    const r = renderCgoNoteEmail({ companyName: "Co", autopilot: true, growthUrl: URL, saw: [], changed: [], need: [], items });
    expect(r.subject).toBe("Co: Applied: Cut “Leads” from $100 to $80 a day.");
    expect(r.text).toContain("What I did\n- Drafted 3 Reddit posts.");
    expect(solidCount(r.html)).toBe(1);
    expect(r.html).not.toContain("Open your Growth page →");
  });
  it("shows at most three proof lines, then N more", () => {
    const changed = ["a one.", "b two.", "c three.", "d four.", "e five."];
    const r = renderCgoNoteEmail({ companyName: "Co", autopilot: true, growthUrl: URL, saw: [], changed, need: [] });
    expect(r.text).toContain("- c three.");
    expect(r.text).not.toContain("d four.");
    expect(r.text).toContain("- 2 more on your Growth page.");
  });
  it("speaks as one 'I': no 'Zavi also writes'", () => {
    const r = renderCgoNoteEmail({ companyName: "Co", autopilot: true, adsEvery2h: true, growthUrl: URL, saw: [], changed: ["Paused Reddit."], need: [], nextReviewAt: "2026-10-30T00:00:00Z" });
    expect(r.html).not.toContain("Zavi also writes");
    expect(r.html).toContain("I write after each check-in");
  });
});

describe("the send gate", () => {
  it("a note with real changes still sends", () => {
    expect(noteWorthSending({ items: [{ section: "changed", text: "Applied: Paused Reddit" }] })).toBe(true);
    expect(noteWorthSending({ changed: ["Paused Reddit."] })).toBe(true);
  });
  it("an alarm that needs the founder still sends", () => {
    expect(noteWorthSending({ items: [{ section: "needs_you", text: "Needs you now: Meta Ads was disconnected", blocker_id: "connector:meta_ads", blocker_severity: "urgent" }] })).toBe(true);
    expect(noteWorthSending({ need: [RAVI_ASK] })).toBe(true);
  });
  it("a note with no decision and no result does not send", () => {
    expect(noteWorthSending({ items: [{ section: "working_on", text: "Working on Research" }, { section: "blocked", text: "Create YT", reason: "Google refused this change. We've been alerted; nothing for you to do" }] })).toBe(false);
    expect(noteWorthSending({ items: [{ section: "decided", text: "Said no to: Raise “X”" }] })).toBe(false);
  });
  it("Autopilot-off advice still sends", () => {
    expect(noteWorthSending({ items: [{ section: "working_on", text: "x" }], would_change: ["Raise Google to $60"] })).toBe(true);
  });
});

describe("Slack follows the same order and words", () => {
  const q = { id: "11111111-1111-4111-8111-111111111111", ordinal: 1, ask: RAVI_ASK, recommended: null, why: null, yesNo: true, noteLine: RAVI_ASK };
  const msg = renderCgoNoteSlackMessage({
    companyName: "UpcarAI", changed: [], need: [RAVI_ASK], growthUrl: URL, kind: "alarm", questions: [q], goals: [goalView], now: NOW,
  });
  it("leads with the one thing and where the founder stands", () => {
    expect(msg.text.split("\n")[0]).toBe("*UpcarAI: Raise “Rent a car at $35 per day” to $214.56 a day?*");
    expect(msg.text).toContain("about 1,071 short");
  });
  it("the call carries its case, and the recommended button is primary", () => {
    const flat = JSON.stringify(msg.blocks);
    expect(flat).toContain("+$35.76 a day");
    expect(flat).toContain("I recommend: Yes.");
    const actions = (msg.blocks as Array<{ type: string; elements?: Array<{ style?: string; text: { text: string } }> }>).find((b) => b.type === "actions")!;
    expect(actions.elements!.find((e) => e.style === "primary")!.text.text).toBe("Yes");
  });
  it("a legacy note's changes read as What I did", () => {
    expect(renderCgoNoteSlack({ companyName: "Co", changed: ["Paused Reddit."], need: [], growthUrl: URL })).toContain("*What I did*");
  });
});
