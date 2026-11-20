import { describe, expect, it } from "vitest";
import { day7Line, day7NoteLines } from "../note";
import { rowFromResult } from "../view";

const STORED_D7 = JSON.parse('{"opens":0,"clicks":2,"from_h1":["recipients","delivered","opens","clicks","unsubscribes"],"delivered":5,"recipients":5,"unsubscribes":0,"provider_status":"disconnected"}');
const REAL_THEN_RERUN = { opens: 3, clicks: 1, delivered: 5, recipients: 5, unsubscribes: 0, provider_status: "disconnected" };
const DISCONNECTED = "SendGrid was disconnected; numbers stopped at 1 hour.";
const OTHER_ACCOUNT = "SendGrid is connected to a different account now; numbers stopped at 1 hour.";
const CLAIMS = /day 7|beat|below|baseline|results are in|%|clicked|visited/i;

const line = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  d7_version: 2,
  route: "sendgrid",
  subject: "Launch week",
  list_name: "Newsletter",
  win_line: { metric: "clicks", threshold: 0.02, basis: "median", n_past: 5 },
  d7: STORED_D7,
  verdict: "beat",
  note: null,
  ...over,
});
const record = (over: Record<string, unknown> = {}) =>
  ({
    rail: "channel_actions", card_id: "c1", route: "sendgrid", subject: "s", list_id: null, list_name: "L", campaign_slug: null, shared_tag: false, sent_count: 5, total_count: null,
    started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:05:00Z", win_line: line().win_line, h1: { delivered: 5, clicks: 2, provider_status: "ok" }, d7: STORED_D7, d7_published_at: "2026-10-27T11:00:00Z", verdict: "beat", note: null, ...over,
  }) as unknown as Parameters<typeof rowFromResult>[0];

describe("carried numbers in the Growth note", () => {
  it.each(["beat", "below", "baseline", "no_signal", "unknown"])("the stored row scored %s stops at 1 hour and claims nothing", (verdict) => {
    const out = day7Line(line({ verdict }) as never);
    expect(out).toBe(`Email "Launch week" to Newsletter: ${DISCONNECTED} Zavi did not judge this email against the win line.`);
    expect(out).not.toMatch(CLAIMS);
  });

  it("a first send and a no-signal win line claim no baseline from carried numbers", () => {
    expect(day7Line(line({ verdict: "baseline", win_line: { metric: "clicks", threshold: null, basis: "first_sends" } }) as never)).not.toMatch(CLAIMS);
    expect(day7Line(line({ verdict: "no_signal", win_line: { metric: null, threshold: null, basis: "no_signal" } }) as never)).not.toMatch(CLAIMS);
  });

  it("a read that gave up, and a swapped account, keep their own words", () => {
    expect(day7Line(line({ d7: { ...STORED_D7, provider_status: "could_not_read" } }) as never)).toContain("SendGrid could not be read; numbers stopped at 1 hour.");
    expect(day7Line(line({ note: OTHER_ACCOUNT }) as never)).toContain(OTHER_ACCOUNT);
  });

  it("real visitors over a carried delivered count are not a day 7 rate", () => {
    const out = day7Line(line({ win_line: { metric: "visitors", threshold: 0.02, basis: "median" }, d7: { ...STORED_D7, visitors: 4, ga_status: "ok" } }) as never);
    expect(out).not.toMatch(CLAIMS);
    expect(out).toContain(DISCONNECTED);
  });

  it("real day 7 numbers keep today's wording, even after a disconnected rerun with the old note", () => {
    const real = 'Email "Launch week" to Newsletter, day 7: 20.0% clicked, win line 2.0%. Beat it.';
    expect(day7Line(line({ d7: REAL_THEN_RERUN, note: DISCONNECTED }) as never)).toBe(real);
    expect(day7Line(line({ d7: { ...REAL_THEN_RERUN, from_h1: ["unsubscribes"] }, note: DISCONNECTED }) as never)).toBe(real);
    expect(day7Line(line({ d7: { ...STORED_D7, clicks: 1, provider_status: "ok" }, note: DISCONNECTED }) as never)).toBe(real);
  });

  it("each line stays paired with its mark, so a carried result is told once", async () => {
    const rows = [line({ id: "a", d7_version: 2 }), line({ id: "b", d7_version: 7, d7: REAL_THEN_RERUN })];
    const out = await day7NoteLines("t", { untold: async () => rows as never });
    expect(out.marks).toEqual([{ id: "a", version: 2 }, { id: "b", version: 7 }]);
    expect(out.lines[0]).toContain(DISCONNECTED);
    expect(out.lines[1]).toContain("Beat it.");
  });
});

describe("carried numbers on the Sent emails row", () => {
  it("the stored beat is not passed on", () => {
    expect(rowFromResult(record())).toMatchObject({ verdict: "unknown", verdict_text: "Numbers stopped at 1 hour: not judged", stopped_at_1_hour: true, clicks: { value: 2 } });
  });

  it("before day 7 is published nothing is flagged", () => {
    expect(rowFromResult(record({ d7_published_at: null, verdict: null }))).toMatchObject({ verdict: null, stopped_at_1_hour: false });
  });

  it("real numbers keep their verdict and lose a stale note; a note with no numbers stays", () => {
    expect(rowFromResult(record({ d7: REAL_THEN_RERUN, note: DISCONNECTED }))).toMatchObject({ verdict: "beat", verdict_text: "Beat the win line", note: null, stopped_at_1_hour: false });
    expect(rowFromResult(record({ d7: { provider_status: "disconnected" }, verdict: "unknown", note: DISCONNECTED })).note).toBe(DISCONNECTED);
  });
});
