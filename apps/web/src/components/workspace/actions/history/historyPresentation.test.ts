import { describe, expect, it } from "vitest";
import { historyOutcome, historyStatus, historyTimeline, historyTone, onTheListPhrase, savedAudienceLines, type HistoryItem } from "./historyPresentation";
import type { ChannelClosedRow } from "../useChannelHistory";

const item = (list: string | null): HistoryItem => ({
  source: "action",
  row: {
    id: "ca-1", run_id: "r", position: 1, run_of: 1, action_type: "send_message", title: "t", status: "acted",
    status_at: "2026-10-16T06:31:00Z", note: null, proposed_at: "2026-10-16T06:30:46Z", impact: 1, impact_reason: null, score: 1,
    sent: { count: 3, list, tool: "zavi_list", at: "2026-10-16T06:31:00Z" },
  } as ChannelClosedRow,
});
const label = (list: string | null) => historyTimeline(item(list))[1].label;

describe("sent label list phrase", () => {
  it("does not double the word list", () => {
    expect(label("QA tiny list")).toBe("Sent to 3 people on the QA tiny list via Zavi");
    expect(label("VIP LIST")).toBe("Sent to 3 people on the VIP LIST via Zavi");
    expect(label("  Customers list  ")).toBe("Sent to 3 people on the Customers list via Zavi");
  });
  it("adds list when the name does not end in the word", () => {
    expect(label("Newsletter")).toBe("Sent to 3 people on the Newsletter list via Zavi");
    expect(label("Checklist")).toBe("Sent to 3 people on the Checklist list via Zavi");
    expect(label("List of buyers")).toBe("Sent to 3 people on the List of buyers list via Zavi");
  });
  it("leaves the phrase out for a null or blank list", () => {
    expect(label(null)).toBe("Sent to 3 people via Zavi");
    expect(label("   ")).toBe("Sent to 3 people via Zavi");
    expect(onTheListPhrase(undefined)).toBe("");
  });
});

const NOTE = "Zavi's sender stopped making progress on this send and could not restart it, so the rest of the list was not emailed. 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.";
const sentItem = (sent: NonNullable<ChannelClosedRow["sent"]>): HistoryItem => {
  const base = item("QA tiny list");
  return { source: "action", row: { ...base.row, title: "New pumpkin spice cupcakes", sent } as ChannelClosedRow };
};

describe("a stopped Zavi-list send in Done (817d)", () => {
  const stopped = sentItem({ count: 1, total: 3, stopped: true, note: NOTE, list: "QA tiny list", tool: "zavi_list", at: "2026-10-16T06:31:00Z" });

  it("reads the card's stopped wording, never a plain Sent", () => {
    const line = historyTimeline(stopped)[1].label;
    expect(line).toBe("Stopped after 1 person on the QA tiny list via Zavi");
    expect(line).not.toMatch(/^Sent/);
  });

  it("tells what was not emailed in the Overview's words and drops the results promise, as the card does for a stopped send", () => {
    const out = historyOutcome(stopped);
    expect(out.text).toBe(NOTE);
    expect(out.text).not.toContain("Results come in");
  });

  it("falls back to the card's rest-not-sent line when no note is served", () => {
    const bare = sentItem({ count: 1, total: 3, stopped: true, list: "QA tiny list", tool: "zavi_list", at: null });
    expect(historyOutcome(bare).text).toBe("The rest were not sent.");
  });

  it("a finished send still reads Sent with the results line", () => {
    const done = sentItem({ count: 3, list: "QA tiny list", tool: "zavi_list", at: "2026-10-16T06:31:00Z" });
    expect(historyTimeline(done)[1].label).toBe("Sent to 3 people on the QA tiny list via Zavi");
    expect(historyOutcome(done).text).toBe("Results come in 1 hour after the send and again at day 7.");
  });
});

describe("a Zavi-list send the founder stopped after it reached people (81b9)", () => {
  const FOUNDER_NOTE = "You stopped this send. 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.";
  const stopped = sentItem({ count: 1, total: 3, stopped: true, note: FOUNDER_NOTE, list: "QA tiny list", tool: "zavi_list", at: "2026-10-22T01:20:00Z" });

  it("reads Stopped after 1 person with the founder's stop note and no results promise", () => {
    const [, line] = historyTimeline(stopped);
    expect(line.label).toBe("Stopped after 1 person on the QA tiny list via Zavi");
    expect(line.at).toBe("2026-10-22T01:20:00Z");
    expect(historyOutcome(stopped)).toEqual({ title: "What happened", text: FOUNDER_NOTE });
  });

  it("a stopped send with many people uses the plural, as the card does", () => {
    const many = sentItem({ count: 1200, total: 3000, stopped: true, note: null, list: "Members", tool: "zavi_list", at: null });
    expect(historyTimeline(many)[1].label).toBe("Stopped after 1,200 people on the Members list via Zavi");
    expect(historyOutcome(many).text).toBe("The rest were not sent.");
  });
});

describe("a posted card with a receipt", () => {
  const posted = (approval: ChannelClosedRow["approval"]): HistoryItem => ({
    source: "action",
    row: {
      ...item(null).row, sent: undefined, action_type: "text_post", approval,
      receipt: { line: "Posted on LinkedIn.", url: "https://www.linkedin.com/feed/update/urn:li:share:1" },
    } as ChannelClosedRow,
  });

  it("keeps who approved it between the suggestion and the receipt", () => {
    expect(historyTimeline(posted({ by: "you", name: null, at: "2026-10-16T06:30:50Z" })).map((s) => s.label)).toEqual([
      "Zavi suggested it",
      "You approved it",
      "Posted on LinkedIn",
    ]);
  });

  it("goes straight to the receipt when nobody approved it", () => {
    expect(historyTimeline(posted(null)).map((s) => s.label)).toEqual(["Zavi suggested it", "Posted on LinkedIn"]);
  });
});

describe("what a tool send brought in Done", () => {
  const AT = "2026-11-02T10:00:00Z";
  const HOUR = 3_600_000;
  const tool = (extra: Partial<NonNullable<ChannelClosedRow["sent"]>> = {}, at: string | null = AT): HistoryItem => {
    const base = item("x");
    return { source: "action", row: { ...base.row, sent: { count: 5, list: "L", tool: "sendgrid", at, ...extra } } as ChannelClosedRow };
  };
  const at = Date.parse(AT);

  it("promises results only until the hour has passed", () => {
    expect(historyOutcome(tool(), at + HOUR - 1).text).toBe("Results come in 1 hour after the send and again at day 7.");
    expect(historyOutcome(tool(), at + HOUR).text).toBe("The 1 hour numbers are not in yet.");
    expect(historyOutcome(tool(), at + 9 * 24 * HOUR).text).not.toContain("Results come in");
  });

  it("serves the stored lines, and the lines replace the sentence", () => {
    const out = historyOutcome(tool({ hour_1: { delivered: 5, opens: 0, clicks: 1 } }), at + 5 * HOUR);
    expect(out.text).toBe("");
    expect(out.results).toEqual([{ label: "After 1 hour:", counts: { delivered: 5, opens: 0, clicks: 1 } }]);
  });

  it("a failed read keeps its reason lines and is not treated as empty", () => {
    const why = { delivered: "SendGrid could not be read", opens: "SendGrid could not be read", clicks: "SendGrid could not be read" };
    const out = historyOutcome(tool({ hour_1: { delivered: null, opens: null, clicks: null, why } }), at + 5 * HOUR);
    expect(out.results).toHaveLength(1);
  });

  it("counts with nothing to show fall back to the sentence by the clock", () => {
    expect(historyOutcome(tool({ hour_1: { delivered: null, opens: null, clicks: null } }), at + 5 * HOUR).text).toBe("The 1 hour numbers are not in yet.");
  });

  it("a send with no time stays on the waiting sentence", () => {
    expect(historyOutcome(tool({}, null), at).text).toBe("Results come in 1 hour after the send and again at day 7.");
  });

  it("a Zavi-list send keeps the waiting sentence even long after, and ignores any results", () => {
    const z = tool({ tool: "zavi_list", hour_1: { delivered: 5, opens: 0, clicks: 1 } });
    expect(historyOutcome(z, at + 30 * 24 * HOUR)).toEqual({ title: "What it brought", text: "Results come in 1 hour after the send and again at day 7." });
  });

  it("a stopped tool send still reads the stopped words, not results", () => {
    const stopped = tool({ stopped: true, note: "NOTE", hour_1: { delivered: 5 } });
    expect(historyOutcome(stopped, at + 5 * HOUR)).toEqual({ title: "What happened", text: "NOTE" });
  });
});

describe("unsubscribes in Done results", () => {
  const item = (sent: Record<string, unknown>) => ({ source: "current", row: { status: "acted", sent: { count: 2, list: "L", tool: "mailchimp", at: "2026-10-20T10:00:00Z", ...sent } } }) as unknown as HistoryItem;
  const blank = { delivered: null, opens: null, clicks: null, bounces: null };

  it("a stage whose only number is an unsubscribe keeps its line", () => {
    expect(historyOutcome(item({ day_7: { ...blank, unsubscribes: 1 } })).results?.map((r) => r.label)).toEqual(["At day 7:"]);
  });

  it("zero unsubscribes alone is still no result line", () => {
    expect(historyOutcome(item({ day_7: { ...blank, unsubscribes: 0 } })).results).toBeUndefined();
  });
});

describe("a card closed with the close icon", () => {
  const closed = (note: string | null): HistoryItem => ({
    source: "action",
    row: { ...item(null).row, status: "rejected", note, sent: undefined } as ChannelClosedRow,
  });
  it("reads as closed, not rejected, when no reason was given", () => {
    expect(historyStatus(closed(null))).toBe("Closed");
    expect(historyTone(closed(null))).toBe("neutral");
    expect(historyTimeline(closed(null))[1].label).toBe("You closed it");
    expect(historyOutcome(closed(null))).toEqual({ title: "What happens next", text: "Nothing runs. Zavi may suggest it again if it still matters." });
  });
  it("stays a rejection when a reason was given", () => {
    expect(historyStatus(closed("Too pushy"))).toBe("Rejected");
    expect(historyTone(closed("Too pushy"))).toBe("danger");
    expect(historyOutcome(closed("Too pushy")).text).toBe("This suggestion was rejected.");
  });
});

describe("a LinkedIn audience card saved from Create audience", () => {
  const LINE = 'Saved to LinkedIn on Main: "Zavi 1: founders at Acme Inc. and more". Saved under LinkedIn\'s own names: Design as "Arts and Design". Not saved, because a LinkedIn saved audience cannot hold them: Students. Add them in Campaign Manager.';
  const saved = (note: string | null): HistoryItem => ({
    source: "action",
    row: { id: "ca-9", run_id: "r", position: 1, run_of: 1, action_type: "send_message", title: "t", status: "acted", status_at: "2026-11-18T06:31:00Z", note, proposed_at: "2026-11-18T06:30:46Z", impact: 1, impact_reason: null, score: 1 } as ChannelClosedRow,
  });

  it("reads as separate lines that lose no word, and the timeline says it was saved to LinkedIn", () => {
    const lines = savedAudienceLines(LINE)!;
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join(" ")).toBe(LINE);
    expect(lines[0].startsWith("Saved to LinkedIn on Main")).toBe(true);
    expect(historyTimeline(saved(LINE))[1].label).toBe("Saved to LinkedIn");
  });

  it("leaves any other done card as it was", () => {
    expect(savedAudienceLines("Looks fine. Really.")).toBeNull();
    expect(savedAudienceLines(null)).toBeNull();
    expect(historyTimeline(saved("Looks fine"))[1].label).toBe("Marked as done");
  });
});
