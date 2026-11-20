import { describe, expect, it } from "vitest";
import { cardSendState, type SendFacts, type ViewState } from "../cards";
import { rowFromResult, ZAVI_UNSUB_NOTE } from "@/services/email-results/view";

const bulk = (over: Partial<NonNullable<SendFacts>["bulk"] & object> = {}) => ({
  status: "done", hold_reason: null, total: 6, sent: 6, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0,
  created_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:05:00Z", next_run_at: null, ...over,
});

const facts = (results: NonNullable<SendFacts>["results"], over: Partial<NonNullable<SendFacts>["bulk"] & object> = {}): SendFacts => ({
  card: { status: "executed", exec_status: "executed", approved: true, executed_at: "2026-10-20T10:05:00Z" },
  bulk: bulk(over),
  results,
});

const view = (cls: string, tool?: string) => ({ status: "acted", class: cls, body: tool ? { tool } : {} }) as unknown as ViewState;

describe("results say why a number is missing", () => {
  it("a sent Zavi-list card with no provider numbers carries the same reasons the Overview table uses", () => {
    const s = cardSendState("decisions", view("bulk_outbound.send"), facts({ sent_count: 6, finished_at: "2026-10-20T10:05:00Z", h1: {}, d7: {}, d7_published: false }));
    expect(s.results).toEqual({
      delivered: null, opens: null, clicks: null, bounces: 0,
      why: { delivered: "No delivery report from the sender yet", opens: "No delivery report from the sender yet", clicks: "Click tracking is off for Zavi's sender: see Visitors" },
    });
  });

  it("an hour-1 snapshot with null counts carries the reasons too", () => {
    const s = cardSendState("decisions", view("bulk_outbound.send"), facts({ sent_count: 6, finished_at: "2026-10-20T10:05:00Z", h1: { provider_status: "ok", bounces: 0 }, d7: {}, d7_published: false }));
    expect(s.hour_1?.why?.clicks).toMatch(/Click tracking is off/);
    expect(s.hour_1?.why?.delivered).toBe("No delivery report from the sender yet");
  });

  it("a card with real counts has no reasons for them", () => {
    const s = cardSendState("decisions", view("bulk_outbound.send"), facts({ sent_count: 6, finished_at: "2026-10-20T10:05:00Z", h1: { delivered: 6, opens: 3, clicks: 1, bounces: 0 }, d7: {}, d7_published: false }));
    expect(s.hour_1).toMatchObject({ delivered: 6, opens: 3, clicks: 1 });
    expect(s.hour_1?.why).toEqual({ delivered: null, opens: null, clicks: null });
  });

  it("a Mailchimp card reads its route from the card body", () => {
    const f: SendFacts = { card: { status: "executed", exec_status: "executed", approved: true }, bulk: null, results: { sent_count: 5, finished_at: "2026-10-20T10:05:00Z", h1: { provider_status: "ok" }, d7: {}, d7_published: false } };
    const s = cardSendState("channel_actions", view("email_campaign.create_and_send", "mailchimp"), f);
    expect(s.hour_1?.why?.clicks).toBe("Mailchimp does not report this");
  });

  it.each(["mailchimp", "sendgrid", "klaviyo"])("a %s send never shows Bounces, whatever the stored numbers hold", (tool) => {
    const f: SendFacts = {
      card: { status: "executed", exec_status: "executed", approved: true },
      bulk: null,
      results: { sent_count: 5, finished_at: "2026-10-20T10:05:00Z", h1: { provider_status: "ok", delivered: 5, opens: 2, clicks: 1, bounces: 3 }, d7: { provider_status: "ok", delivered: 4, opens: 3, clicks: 1, bounces: 4 }, d7_published: true },
    };
    const s = cardSendState("channel_actions", view("email_campaign.create_and_send", tool), f);
    expect(s.hour_1?.bounces).toBeNull();
    expect(s.day_7?.bounces).toBeNull();
    expect(s.results?.bounces).toBeNull();
  });
});

describe("unsubscribes reach the card from the stored stage row", () => {
  const FINISHED = "2026-10-20T10:05:00Z";
  const stateFor = (route: string, h1: Record<string, unknown>, d7: Record<string, unknown>, published = true) => {
    const results = { sent_count: 6, finished_at: FINISHED, h1, d7, d7_published: published };
    if (route === "zavi_list") return cardSendState("decisions", view("bulk_outbound.send"), facts(results));
    const f = { ...facts(results), bulk: null } as SendFacts;
    return cardSendState("channel_actions", view("email_campaign.create_and_send", route), f);
  };
  const stage = (unsubscribes: unknown) => ({ provider_status: "ok", delivered: 1, opens: 0, clicks: 0, unsubscribes });

  for (const route of ["mailchimp", "klaviyo", "sendgrid", "zavi_list"]) {
    it(`${route}: hour 1 and day 7 keep their own figure`, () => {
      const s = stateFor(route, stage(0), stage(3));
      expect(s.hour_1?.unsubscribes).toBe(0);
      expect(s.day_7?.unsubscribes).toBe(3);
      expect(s.results?.unsubscribes).toBe(3);
      const flipped = stateFor(route, stage(2), stage(null));
      expect(flipped.hour_1?.unsubscribes).toBe(2);
      expect(flipped.day_7?.unsubscribes).toBeNull();
    });
  }

  it("the mirror's Mailchimp and Klaviyo rows carry the 1, with no Zavi double-count note", () => {
    for (const route of ["mailchimp", "klaviyo", "sendgrid"]) {
      const s = stateFor(route, {}, stage(1));
      expect(s.day_7?.unsubscribes).toBe(1);
      expect(s.day_7?.unsubscribes_note).toBeUndefined();
    }
  });

  it("the Zavi list says a person can count on two sends, only when there is a count", () => {
    const s = stateFor("zavi_list", stage(0), stage(2));
    expect(s.day_7?.unsubscribes_note).toBe(ZAVI_UNSUB_NOTE);
    expect(s.hour_1?.unsubscribes_note).toBeUndefined();
    expect(stateFor("zavi_list", stage(null), stage(null)).day_7?.unsubscribes_note).toBeUndefined();
  });

  it("a non-number stored value is unknown, not a count", () => {
    expect(stateFor("mailchimp", {}, stage("1")).day_7?.unsubscribes).toBeNull();
  });

  it("a day-7 number carried from hour 1 stays the hour-1 figure, matching the table cell", () => {
    const d7 = { ...stage(4), provider_status: "disconnected", from_h1: ["unsubscribes"] };
    const s = stateFor("klaviyo", stage(4), d7);
    expect(s.day_7?.unsubscribes).toBe(4);
    expect(s.day_7?.note).toBe("Klaviyo was disconnected; numbers stopped at 1 hour.");
    const row = rowFromResult({
      rail: "channel_actions", card_id: "c", route: "klaviyo", subject: "S", list_id: null, list_name: null, campaign_slug: null, shared_tag: false,
      sent_count: 6, total_count: 6, started_at: FINISHED, finished_at: FINISHED, win_line: {}, h1: stage(4), d7, d7_published_at: FINISHED, verdict: null, note: null,
    });
    expect(row.unsubscribes.value).toBe(s.day_7?.unsubscribes);
    expect(row.unsubscribes.why).toMatch(/^From the 1-hour check/);
  });
});
