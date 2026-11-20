import { describe, expect, it, vi } from "vitest";
import { cardOutcome, cardSendFacts, cardSendState, stageCounts, type CardDeps, type SendFacts, type ViewState } from "@/services/email-cards/cards";
import { carriedNote, rowFromInFlight, rowFromResult } from "../view";

const STORED_D7 = JSON.parse('{"opens":0,"clicks":0,"from_h1":["recipients","delivered","opens","clicks","unsubscribes"],"delivered":5,"recipients":5,"unsubscribes":0,"provider_status":"disconnected"}');
const H1 = { opens: 0, clicks: 0, delivered: 5, recipients: 5, unsubscribes: 0, provider_status: "ok" };
const REAL_THEN_RERUN = { opens: 3, clicks: 1, delivered: 5, recipients: 5, unsubscribes: 0, provider_status: "disconnected" };
const DISCONNECTED = "SendGrid was disconnected; numbers stopped at 1 hour.";
const OTHER_ACCOUNT = "SendGrid is connected to a different account now; numbers stopped at 1 hour.";

const view = (tool: string) => ({ status: "acted", class: "email_campaign.create_and_send", body: { tool } }) as unknown as ViewState;
const facts = (d7: Record<string, unknown>, published = true, note?: string | null): NonNullable<SendFacts> => ({
  card: { status: "acted", exec_status: "executed", approved: true, executed_at: "2026-10-20T10:05:00Z" },
  bulk: null,
  results: { sent_count: 5, finished_at: "2026-10-20T10:05:00Z", h1: H1, d7, d7_published: published, ...(note === undefined ? {} : { note }) },
});
const record = (over: Record<string, unknown> = {}) =>
  ({
    rail: "channel_actions", card_id: "c1", route: "sendgrid", subject: "s", list_id: null, list_name: "L", campaign_slug: null, shared_tag: false, sent_count: 5, total_count: null,
    started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:05:00Z", win_line: {}, h1: H1, d7: STORED_D7, d7_published_at: "2026-10-27T11:00:00Z", verdict: null, note: null, ...over,
  }) as unknown as Parameters<typeof rowFromResult>[0];

describe("day 7 numbers carried from 1 hour say so", () => {
  it("the exact stored row, read through the card's facts, tells the founder the day 7 numbers stopped at 1 hour", async () => {
    const resultNote = vi.fn(async () => DISCONNECTED);
    const rpc = (async () => facts(STORED_D7)) as unknown as CardDeps["rpc"];
    const f = await cardSendFacts("t", "channel_actions", "c1", { rpc, resultNote });
    const s = cardSendState("channel_actions", view("sendgrid"), f);
    expect(s.day_7).toMatchObject({ delivered: 5, opens: 0, clicks: 0, note: DISCONNECTED });
    expect(s.results?.note).toBe(DISCONNECTED);
    expect(s.hour_1?.note).toBeUndefined();
    expect(cardOutcome(s, f).status).toBe("sent");
    expect(resultNote).toHaveBeenCalledTimes(1);
  });

  it("a swapped account keeps its own words, never 'was disconnected'", async () => {
    const rpc = (async () => facts(STORED_D7)) as unknown as CardDeps["rpc"];
    const f = await cardSendFacts("t", "channel_actions", "c1", { rpc, resultNote: async () => OTHER_ACCOUNT });
    const s = cardSendState("channel_actions", view("sendgrid"), f);
    expect(s.day_7?.note).toBe(OTHER_ACCOUNT);
    expect(JSON.stringify(s)).not.toContain("was disconnected");
  });

  it("a failed read of the stored note still warns, and does not fail the card", async () => {
    const rpc = (async () => facts(STORED_D7)) as unknown as CardDeps["rpc"];
    const f = await cardSendFacts("t", "channel_actions", "c1", { rpc, resultNote: async () => { throw new Error("db down"); } });
    expect(cardSendState("channel_actions", view("sendgrid"), f).day_7?.note).toBe(DISCONNECTED);
  });

  it.each([[{ ...STORED_D7, from_h1: undefined }], [REAL_THEN_RERUN]])("no carry costs no extra read", async (d7) => {
    const resultNote = vi.fn(async () => DISCONNECTED);
    const rpc = (async () => facts(d7)) as unknown as CardDeps["rpc"];
    await cardSendFacts("t", "channel_actions", "c1", { rpc, resultNote });
    expect(resultNote).not.toHaveBeenCalled();
  });

  it("before day 7 is published the same stored d7 stays hidden and costs no read", async () => {
    const resultNote = vi.fn(async () => DISCONNECTED);
    const rpc = (async () => facts(STORED_D7, false)) as unknown as CardDeps["rpc"];
    const f = await cardSendFacts("t", "channel_actions", "c1", { rpc, resultNote });
    const s = cardSendState("channel_actions", view("sendgrid"), f);
    expect(s.day_7).toBeUndefined();
    expect(s.results?.note).toBeUndefined();
    expect(resultNote).not.toHaveBeenCalled();
  });

  it.each([
    ["sendgrid", "SendGrid"],
    ["mailchimp", "Mailchimp"],
    ["klaviyo", "Klaviyo"],
  ] as const)("%s shares the path, for a disconnect and for a read that gave up", (route, label) => {
    expect(stageCounts(STORED_D7, null, route)?.note).toBe(`${label} was disconnected; numbers stopped at 1 hour.`);
    expect(stageCounts({ ...STORED_D7, provider_status: "could_not_read" }, null, route)?.note).toBe(`${label} could not be read; numbers stopped at 1 hour.`);
    expect(rowFromResult(record({ route, note: null })).numbers_note).toBe(`${label} was disconnected; numbers stopped at 1 hour.`);
  });

  it("a stored 'no longer in the tool' note is the one shown", () => {
    const stored = "This email is no longer in SendGrid; numbers stopped at 1 hour.";
    expect(stageCounts({ ...STORED_D7, provider_status: "could_not_read" }, null, "sendgrid", stored)?.note).toBe(stored);
  });

  it("a stored note about something else is not shown as the reason", () => {
    expect(carriedNote(STORED_D7, "sendgrid", "SendGrid was disconnected; numbers stopped before the 1-hour check.")).toBe(DISCONNECTED);
  });

  it("real day 7 numbers read earlier, then a disconnected rerun with no from_h1, keep their numbers with no note, even with the stored note", () => {
    const s = cardSendState("channel_actions", view("sendgrid"), facts(REAL_THEN_RERUN, true, DISCONNECTED));
    expect(s.day_7).toMatchObject({ delivered: 5, opens: 3, clicks: 1 });
    expect(s.day_7).not.toHaveProperty("note");
    const row = rowFromResult(record({ d7: REAL_THEN_RERUN, note: DISCONNECTED }));
    expect(row.opens.value).toBe(3);
    expect(row.numbers_note).toBeNull();
  });

  it("a stale from_h1 on a read that answered, or a carry of nothing shown, is no note", () => {
    expect(carriedNote({ ...STORED_D7, provider_status: "ok" }, "sendgrid", DISCONNECTED)).toBeNull();
    expect(carriedNote({ delivered: 5, recipients: 5, from_h1: ["recipients"], provider_status: "disconnected" }, "sendgrid")).toBeNull();
    expect(carriedNote({ from_h1: "delivered", delivered: 5, provider_status: "disconnected" }, "sendgrid")).toBeNull();
  });

  it("a counts-free stage and an unknown route stay as they were", () => {
    expect(stageCounts(STORED_D7)).not.toHaveProperty("note");
    expect(stageCounts({ provider_status: "disconnected" }, null, "sendgrid")).not.toHaveProperty("note");
  });

  it("the Sent emails row: the note only once day 7 is published, using the stored different-account words", () => {
    expect(rowFromResult(record({ note: OTHER_ACCOUNT })).numbers_note).toBe(OTHER_ACCOUNT);
    expect(rowFromResult(record({ note: OTHER_ACCOUNT, d7_published_at: null })).numbers_note).toBeNull();
  });

  it("a send still going has no note", () => {
    expect(rowFromInFlight({ decision_id: "d", status: "sending", hold_reason: null, sent: 1, total: 2, created_at: "2026-10-20T10:00:00Z", subject: "s", list_id: null, list_name: null }).numbers_note).toBeNull();
  });
});
