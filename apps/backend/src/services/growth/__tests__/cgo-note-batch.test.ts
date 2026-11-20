import { describe, it, expect } from "vitest";
import { mergeNotes, primaryNote, type BatchNote } from "../cgo-note-batch";
import { deriveHeadline, parseNoteItems } from "../cgo-note-items";

const note = (over: Partial<BatchNote> & Pick<BatchNote, "id" | "created_at">): BatchNote => ({
  run_id: null,
  kind: "alarm",
  saw: null,
  changed: null,
  would_change: null,
  need: null,
  next_review_at: "2026-10-24T00:00:00Z",
  items: null,
  headline: null,
  ...over,
});

const CARD = 'Let the campaign that books spend the extra $10 a day';

describe("mergeNotes", () => {
  it("one note comes back exactly as it was", () => {
    const n = note({ id: "a", created_at: "2026-10-17T06:43:26Z", need: ["x"], headline: "Own headline here, kept as written." });
    expect(mergeNotes([n])).toBe(n);
  });

  it("2026-10-17 06:43: the gate's question and the review's note become one email, the review leading", () => {
    const alarm = note({
      id: "a603a17c",
      created_at: "2026-10-17T06:43:26Z",
      need: [`Google Ads still has an open card, "${CARD}", about the same thing as "update campaign budget". Which should Google Ads follow?`],
    });
    const review = note({
      id: "9ad67859",
      run_id: "86221677",
      kind: "founder",
      created_at: "2026-10-17T06:43:34Z",
      next_review_at: "2026-10-20T00:00:00Z",
      items: [{ section: "needs_you", text: `Your call: ${CARD}` }, { section: "changed", text: "Paused the TikTok test" }],
      headline: "1 thing needs you. First: Your call.",
    });
    const m = mergeNotes([review, alarm]);
    expect(m).toMatchObject({ id: "9ad67859", run_id: "86221677", kind: "founder", next_review_at: "2026-10-20T00:00:00Z", headline: null });
    const items = parseNoteItems(m.items)!;
    expect(items.map((i) => i.section)).toEqual(["needs_you", "needs_you", "changed"]);
    expect(deriveHeadline(items)).toMatch(/^2 things need you\./);
  });

  it("2026-10-15 07:07: three blocker alerts in one second, two with the same line, are one email with no repeat", () => {
    const line = "Check LinkedIn Ads: 'Review and create your LinkedIn campaign' may already be partly live";
    const alerts = ["f0caa16c", "89bec06e", "952def6f"].map((id, i) =>
      note({
        id,
        created_at: `2026-10-15T07:07:3${8 + (i ? 1 : 0)}.${i}Z`,
        items: [{ section: "needs_you", text: i === 2 ? "Reconnect LinkedIn Ads" : line, blocker_id: `check:${id}`, blocker_severity: "urgent" }],
        headline: `Needs you now: ${i === 2 ? "Reconnect LinkedIn Ads" : line}`,
      }),
    );
    const items = parseNoteItems(mergeNotes(alerts).items)!;
    expect(items.map((i) => i.text)).toEqual([line, "Reconnect LinkedIn Ads"]);
  });

  it("legacy notes only: lines merged, exact repeats dropped, no items invented", () => {
    const a = note({ id: "a", created_at: "2026-10-13T01:41:45Z", need: ["I did not apply the Gig Rentals raise on my own."] });
    const b = note({ id: "b", created_at: "2026-10-13T01:41:56Z", need: ["I did not apply the Sales Search raise on my own.", "I did not apply the Gig Rentals raise on my own."], changed: ["Sent the weekly email"] });
    const m = mergeNotes([b, a]);
    expect(m.items).toBeNull();
    expect(m.need).toEqual(["I did not apply the Gig Rentals raise on my own.", "I did not apply the Sales Search raise on my own."]);
    expect(m.changed).toEqual(["Sent the weekly email"]);
  });
});

describe("primaryNote", () => {
  it("the newest review note, else the newest note", () => {
    const old = { id: "r1", run_id: "r1", created_at: "2026-10-17T06:00:00Z" };
    const alarm = { id: "a", run_id: null, created_at: "2026-10-17T06:50:00Z" };
    expect(primaryNote([old, alarm]).id).toBe("r1");
    expect(primaryNote([alarm]).id).toBe("a");
  });
});
