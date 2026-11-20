import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailResultsHandlers } from "@/routes/email-results";
import { DAY7_NOTE_CAP, day7Line, day7NoteLines, markDay7Told } from "../note";
import { cardWinLine } from "../card";
import { listSentEmails, listSentEmailsPage, providerCell, rowFromResult, VISITORS_RULE, visitorsCell } from "../view";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
  };
}

const record = (over: Record<string, unknown> = {}) => ({
  rail: "decisions",
  card_id: "22222222-2222-4222-8222-222222222222",
  route: "sendgrid",
  subject: "Launch week",
  list_name: "Newsletter",
  campaign_slug: "launch-week-20261012-abcdefghij",
  shared_tag: false,
  sent_count: 300,
  total_count: null,
  started_at: "2026-10-12T15:00:00Z",
  finished_at: "2026-10-12T15:00:00Z",
  win_line: { metric: "clicks", threshold: 0.03, basis: "median", n_past: 4 },
  h1: { delivered: 290, opens: 80, clicks: 4, unsubscribes: 0, provider_status: "ok" },
  d7: {},
  d7_published_at: null,
  verdict: null,
  note: null,
  ...over,
});

describe("GET /api/email-results", () => {
  it("reads the session's tenant only, never a query value; rows carry no provider id or credential", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "u1" });
    const seen: string[] = [];
    const h = emailResultsHandlers({ list: async (t) => (seen.push(t), { emails: [rowFromResult(record() as never)], more: false }) });
    const r = res();
    await h.list({ query: {} } as never, r as never);
    expect(seen).toEqual(["tenant-a"]);
    expect(r.body.emails[0]).toMatchObject({ sent_with: "SendGrid", as_of: "h1", card: { rail: "decisions" } });
    expect(JSON.stringify(r.body)).not.toMatch(/provider_ref|account_ref|key_digest/);
    const bad = res();
    await h.list({ query: { tenant_id: "tenant-b" } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
    expect(seen).toEqual(["tenant-a"]);
  });

  it("a workspace with more sends than the page says so, and the page holds exactly the newest limit", async () => {
    const asked: number[] = [];
    const many = Array.from({ length: 51 }, (_, i) => record({ card_id: `d-${i}` }) as never);
    const results = async (_t: string, limit: number) => (asked.push(limit), many.slice(0, limit));
    const h = emailResultsHandlers({ list: (t, limit) => listSentEmailsPage(t, limit, { results, inFlight: async () => [] }) });
    const r = res();
    await h.list({ query: {} } as never, r as never);
    expect(r.body.more).toBe(true);
    expect(r.body.emails).toHaveLength(50);
    expect(r.body.emails.map((e: { card: { id: string } }) => e.card.id)).not.toContain("d-50");
    const exact = await listSentEmailsPage("t", 50, { results: async (_t, limit) => many.slice(0, Math.min(limit, 50)), inFlight: async () => [] });
    expect(exact.more).toBe(false);
    expect(exact.emails).toHaveLength(50);
    expect(asked).toEqual([51]);
  });

  it("not signed in: no read", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const list = vi.fn();
    await emailResultsHandlers({ list }).list({ query: {} } as never, res() as never);
    expect(list).not.toHaveBeenCalled();
  });

  it("sends still going come first, without numbers; a finished send is not listed twice", async () => {
    const rows = await listSentEmails("t", 50, {
      results: async () => [record({ card_id: "d-done" }) as never],
      inFlight: async () => [
        { decision_id: "d-going", status: "sending", hold_reason: null, sent: 10, total: 90, created_at: "2026-10-12T10:00:00Z", subject: "Hi", list_id: null, list_name: "L" },
        { decision_id: "d-done", status: "sending", hold_reason: null, sent: 1, total: 1, created_at: "2026-10-12T10:00:00Z", subject: "Hi", list_id: null, list_name: "L" },
      ],
    });
    expect(rows.map((r) => [r.card.id, r.stage])).toEqual([["d-going", "sending"], ["d-done", "h1"]]);
    expect(rows[0].verdict_text).toBe("Sending, 10 of 90 so far");
  });
});

describe("cells", () => {
  it("a missing number says why, never 0", () => {
    expect(providerCell({ provider_status: "ok" }, "clicks", "mailchimp")).toEqual({ value: null, why: "Mailchimp does not report this" });
    expect(providerCell({}, "clicks", "zavi_list").why).toMatch(/Click tracking is off/);
    expect(providerCell({}, "delivered", "zavi_list").why).toBe("No delivery report from the sender yet");
    expect(providerCell({ provider_status: "disconnected" }, "opens", "klaviyo").why).toBe("Disconnected before this was read");
    expect(providerCell({ opens: 0, provider_status: "ok" }, "opens", "klaviyo")).toEqual({ value: 0, why: null });
    expect(providerCell({ delivered: 80, from_h1: ["delivered"], provider_status: "could_not_read" }, "delivered", "sendgrid")).toEqual({
      value: 80,
      why: "From the 1-hour check: day 7 could not be read",
    });
  });

  it("visitors: connect GA, not tagged, shared tag, or the count", () => {
    const base = { campaign_slug: "x", shared_tag: false, d7_published_at: "2026-10-20T00:00:00Z", finished_at: "2026-10-12T00:00:00Z" };
    expect(visitorsCell({ ...base, d7: { ga_status: "not_connected", visitors: null } })).toEqual({ value: null, why: "Connect Google Analytics", action: "connect_ga" });
    expect(visitorsCell({ ...base, campaign_slug: null, d7: {} }).why).toBe("Not tagged");
    expect(visitorsCell({ ...base, shared_tag: true, d7: {} }).why).toMatch(/Shared tag/);
    expect(visitorsCell({ ...base, d7: { visitors: 12 } })).toEqual({ value: 12, why: VISITORS_RULE });
    expect(VISITORS_RULE).toMatch(/hour the send started/);
    expect(VISITORS_RULE).toMatch(/test emails are left out/);
  });

  it("day 7: its own numbers and verdict; a long send says the hour counts from its finish; a stopped send says N of M", () => {
    const r = rowFromResult(record({ d7_published_at: "2026-10-20T00:00:00Z", d7: { delivered: 295, clicks: 12, provider_status: "ok", visitors: 30, ga_status: "ok" }, verdict: "beat" }) as never);
    expect(r).toMatchObject({ as_of: "d7", verdict_text: "Beat the win line", d7_due_at: null, clicks: { value: 12 }, visitors: { value: 30 } });
    const long = rowFromResult(record({ route: "zavi_list", started_at: "2026-10-12T10:00:00Z", finished_at: "2026-10-14T10:00:00Z", total_count: 900, sent_count: 340 }) as never);
    expect(long).toMatchObject({ spanned: true, opens_label: "Opens (all)", people: { sent: 340, total: 900, stopped: true } });
    const carried = rowFromResult(record({ route: "zavi_list", d7_published_at: "2026-10-20T00:00:00Z", d7: { unsubscribes: 2, from_h1: ["unsubscribes"], provider_status: "could_not_read" }, verdict: "unknown" }) as never);
    expect(carried.unsubscribes.value).toBe(2);
    expect(carried.unsubscribes.why).toContain("From the 1-hour check");
    expect(carried.unsubscribes.why).toContain("counts on both");
  });

  it("the day-7 due day is the workspace's day: a send at 04:00 IST is due on its IST day, not the UTC day before", async () => {
    const ist = record({ finished_at: "2026-10-17T22:30:00Z", started_at: "2026-10-17T22:00:00Z" });
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(rowFromResult(ist as never, now).verdict_text).toBe("Due Oct 24");
    expect(rowFromResult(ist as never, now, "Asia/Kolkata").verdict_text).toBe("Due Oct 25");
    expect(rowFromResult(ist as never, now, "Asia/Kolkata").visitors).toEqual({ value: null, why: "Due Oct 25" });
    expect(visitorsCell({ campaign_slug: "x", shared_tag: false, d7: {}, d7_published_at: null, finished_at: "2026-10-17T22:30:00Z" }, now, "Asia/Kolkata").why).toBe("Due Oct 25");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const rows = await listSentEmails("t", 5, { results: async () => [ist as never], inFlight: async () => [], zone: async () => "Asia/Kolkata" });
      expect(rows[0].verdict_text).toBe("Due Oct 25");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows a due date that has passed: before due it says Due <day>, after it says Reading now", async () => {
    const late = record({ finished_at: "2026-10-17T10:00:00Z", started_at: "2026-10-17T09:00:00Z" });
    const before = rowFromResult(late as never, Date.parse("2026-10-20T12:00:00Z"));
    expect(before.verdict_text).toBe("Due Oct 24");
    expect(before.visitors).toEqual({ value: null, why: "Due Oct 24" });
    expect(before.d7_due_at).toBe("2026-10-24T10:00:00.000Z");

    const between = rowFromResult(late as never, Date.parse("2026-10-24T15:00:00Z"));
    expect(between.verdict_text).toBe("Reading now");
    expect(between.visitors.why).toBe("Due Oct 24");

    const after = rowFromResult(late as never, Date.parse("2026-10-26T12:00:00Z"));
    expect(after.verdict_text).toBe("Reading now");
    expect(after.visitors).toEqual({ value: null, why: "Reading now" });
    expect(JSON.stringify(after)).not.toMatch(/Due Oct/);

    const publishedNoVisitors = { campaign_slug: "x", shared_tag: false, d7: { ga_status: "ok" }, d7_published_at: "2026-10-24T11:00:00Z", finished_at: "2026-10-17T10:00:00Z" };
    expect(visitorsCell(publishedNoVisitors, Date.parse("2026-10-24T12:00:00Z")).why).toBe("Due Oct 24");
    expect(visitorsCell(publishedNoVisitors, Date.parse("2026-10-26T12:00:00Z")).why).toBe("Reading now");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
      const rows = await listSentEmails("t", 50, { results: async () => [late as never, record({ card_id: "d-2", finished_at: "2026-10-17T10:00:00Z" }) as never], inFlight: async () => [] });
      expect(rows.map((r) => [r.verdict_text, r.visitors.why])).toEqual([["Reading now", "Reading now"], ["Reading now", "Reading now"]]);
      expect(JSON.stringify(rows)).not.toMatch(/Due Oct/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("day-7 note lines", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    d7_version: 3,
    subject: "Launch week",
    list_name: "Newsletter",
    win_line: { metric: "visitors", threshold: 0.02, basis: "median" },
    d7: { delivered: 200, visitors: 6 },
    verdict: "beat",
    ...over,
  });

  it("plain words for every verdict", () => {
    expect(day7Line(row() as never)).toBe('Email "Launch week" to Newsletter, day 7: 3.0% visited your site, win line 2.0%. Beat it.');
    expect(day7Line(row({ verdict: "below", d7: { delivered: 200, visitors: 1 } }) as never)).toBe('Email "Launch week" to Newsletter, day 7: 0.50% visited your site, win line 2.0%. Below it.');
    expect(day7Line(row({ verdict: "baseline", win_line: { metric: "clicks", threshold: null, basis: "first_sends" }, d7: { delivered: 100, clicks: 3 } }) as never)).toBe(
      'Email "Launch week" to Newsletter, day 7: 3.0% clicked. This sets your baseline.',
    );
    expect(day7Line(row({ verdict: "no_signal", win_line: { metric: null, basis: "no_signal" } }) as never)).toMatch(/no click or visitor signal/);
    expect(day7Line(row({ verdict: "unknown" }) as never)).toMatch(/could not tell/);
  });

  it("capped per note; a read error costs the lines, never the note; marking failure never throws", async () => {
    let asked = 0;
    const out = await day7NoteLines("t", { untold: async (_t, n) => ((asked = n), [row() as never]) });
    expect(asked).toBe(DAY7_NOTE_CAP);
    expect(out.marks).toEqual([{ id: "r1", version: 3 }]);
    expect(await day7NoteLines("t", { untold: async () => Promise.reject(new Error("down")) })).toEqual({ lines: [], marks: [] });
    await expect(markDay7Told("t", [{ id: "r1", version: 3 }], { markTold: async () => Promise.reject(new Error("down")) })).resolves.toBeUndefined();
  });
});

describe("the card's win line", () => {
  const body = { tool: "mailchimp", audience_id: "L1", variants: [{}], template_snapshot: { campaign_slug: "s-20261012-abcdefghij" } };

  it("frozen once sent", async () => {
    const w = await cardWinLine("t", "channel_actions", "c", "email_campaign.create_and_send", body, {
      frozen: async () => ({ metric: "clicks", threshold: 0.05, basis: "median", n_past: 5 }),
    });
    expect(w).toEqual({ text: "5.0% of delivered click", metric: "clicks", threshold: 0.05, frozen: true });
  });

  it("before the send: what it would be now, from this list's own history; GA decides the metric", async () => {
    const asked: unknown[] = [];
    const w = await cardWinLine("t", "channel_actions", "c", "email_campaign.create_and_send", body, {
      frozen: async () => null,
      gaConnected: async () => true,
      compute: async (_t, a) => (asked.push(a), { metric: "visitors", threshold: null, basis: "first_sends", n_past: 1 }),
    });
    expect(asked).toEqual([{ route: "mailchimp", listId: "L1", tagged: true, gaConnected: true }]);
    expect(w).toMatchObject({ text: "First send: sets your baseline", frozen: false });
  });

  it("an error is no win line, never a broken card", async () => {
    expect(await cardWinLine("t", "decisions", "c", "bulk_outbound.send", body, { frozen: async () => Promise.reject(new Error("x")) })).toBeNull();
  });
});
