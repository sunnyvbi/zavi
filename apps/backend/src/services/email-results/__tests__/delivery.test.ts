import { beforeEach, describe, expect, it } from "vitest";
import { resetKlaviyoMetricCache } from "@/services/connectors/email-campaign/providers";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { cardSendState } from "@/services/email-cards/cards";
import { renderEmailSendOutcomeEmail, emailSendOutcomeLine } from "@/email/templates/email-send-outcome";
import { autopilotSendLine } from "@/services/growth/cgo-email";
import { tellEmailSendOutcome } from "@/services/email-cards/outcome";
import { runEmailResultsPass, type CheckDeps, type ClaimedTask, type Completion } from "../check";
import { deliveryOf, deliveryReason, NOBODY_REACHED_REASON } from "../delivery";
import { providerCell, rowFromResult } from "../view";

const T = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-20T12:00:00Z");

const task = (route: "sendgrid" | "mailchimp" | "klaviyo"): ClaimedTask => ({
  task_id: "task-1", lease_token: "lease", tenant_id: T, source: "provider", stage: "h1", state: "pending", attempts: 0, group_key: "g", give_up_at: "2026-10-30T00:00:00Z",
  result_id: "r1", rail: "channel_actions", card_id: "c1", route, provider_ref: "ss-1", account_ref: null, campaign_title: null, campaign_slug: null,
  started_at: "2026-10-12T15:00:00Z", finished_at: "2026-10-12T15:00:00Z", ga_property_id: null, ga_timezone: null,
});

function pass(call: (op: string) => Promise<ComposioExecResult>, route: "sendgrid" | "mailchimp" = "sendgrid"): Promise<Completion[]> {
  const done: Completion[] = [];
  const deps: CheckDeps = {
    claim: async () => [task(route)],
    complete: async (_t, c) => { done.push(c); },
    providerAccess: async () => ({ kind: "ok", call: call as never, sameCredential: true, cacheKey: "k" }),
    bulkCounts: async () => null, gaCreds: async () => null, gaReport: async () => ({}), missing: async () => [], start: async () => ({ started: false }),
    holdRepair: async () => undefined, backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }), purgeEventIds: async () => 0, alertStuck: async () => undefined,
    log: async () => undefined, now: () => NOW,
  } as CheckDeps;
  return runEmailResultsPass(deps).then(() => done);
}

describe("a results read with no numbers", () => {
  it("SendGrid with an empty stats row is tried again and marked as an empty report, never done", async () => {
    const sg = fakeSendgrid();
    const [c] = await pass(sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch) as never);
    expect(c.outcome).toBe("retry");
    expect(c.result).toEqual({ reported_empty: true });
    expect(c.error).toMatch(/SendGrid reported no numbers/);
  });

  it("SendGrid with real numbers completes", async () => {
    const sg = fakeSendgrid();
    sg.stats["ss-1"] = { requests: 5, delivered: 4, unique_opens: 1, unique_clicks: 0, unsubscribes: 0 } as never;
    const [c] = await pass(sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch) as never);
    expect(c.outcome).toBe("done");
  });

  it("an empty read that gave up says SendGrid reported nothing, not that the tool could not be read or does not report it", () => {
    expect(providerCell({ provider_status: "could_not_read", reported_empty: true }, "delivered", "sendgrid").why).toBe("SendGrid reported no numbers for this email");
  });
});

describe("what SendGrid's numbers say about a send it accepted", () => {
  it("nothing read yet is unconfirmed, whatever Zavi counted on the list", () => {
    expect(deliveryOf("sendgrid", {}, null)).toEqual({ state: "unconfirmed", people: null });
  });
  it("an empty report that ran out of retries means nobody was reached", () => {
    expect(deliveryOf("sendgrid", { provider_status: "could_not_read", reported_empty: true }, null)).toEqual({ state: "nobody", people: 0 });
  });
  it("a real day-7 number beats an empty 1-hour read", () => {
    expect(deliveryOf("sendgrid", { reported_empty: true }, { recipients: 3, delivered: 3 })).toEqual({ state: "reached", people: 3 });
  });
  it("a read that failed for another reason is not 'nobody reached'", () => {
    expect(deliveryOf("sendgrid", { provider_status: "could_not_read" }, null)).toEqual({ state: "unconfirmed", people: null });
  });
  it("an empty Mailchimp or Klaviyo report is not proof of nobody: their reports come late", () => {
    expect(deliveryOf("mailchimp", { reported_empty: true }, null)).toEqual({ state: "unconfirmed", people: null });
    expect(deliveryOf("klaviyo", { reported_empty: true }, null)).toEqual({ state: "unconfirmed", people: null });
  });

  it("a Zavi list is not judged here", () => {
    expect(deliveryOf("zavi_list", { recipients: 5 }, null)).toBeNull();
  });
});

describe("every surface of the 5-people send SendGrid dropped", () => {
  const view = { ok: true, status: "acted", class: "email_campaign.send", retryable: false, body: { tool: "sendgrid" } } as never;
  const facts = (h1: Record<string, unknown>) =>
    ({
      card: { status: "acted", exec_status: "executed", approved: true, executed_at: "2026-11-02T06:30:48Z", receipt: { line: "SendGrid accepted this send for a list of 5 people. Delivery is not confirmed yet" } },
      results: { sent_count: 5, finished_at: "2026-11-02T06:30:45Z", h1, d7: {}, d7_published: false },
      bulk: null,
    }) as never;

  it("the card never reports the list's count as people reached", () => {
    expect(cardSendState("channel_actions", view, facts({}))).toMatchObject({ status: "sent", delivery: "unconfirmed", sent_count: null });
  });

  it("after the empty reads ran out the card says nobody was reached, and why", () => {
    expect(cardSendState("channel_actions", view, facts({ provider_status: "could_not_read", reported_empty: true }))).toMatchObject({
      delivery: "nobody", sent_count: 0, failure_reason: NOBODY_REACHED_REASON,
    });
  });

  it("real numbers replace it", () => {
    expect(cardSendState("channel_actions", view, facts({ recipients: 3, delivered: 3, provider_status: "ok" }))).toMatchObject({ delivery: "reached", sent_count: 3 });
  });

  it("the Sent emails row hides the stored list count until SendGrid gives a number", () => {
    const row = rowFromResult({
      rail: "channel_actions", card_id: "c1", route: "sendgrid", subject: "s", list_name: "test", started_at: "2026-11-02T06:30:45Z", finished_at: "2026-11-02T06:30:45Z",
      sent_count: 5, total_count: null, h1: {}, d7: {}, d7_published_at: null, win_line: {}, campaign_slug: null, shared_tag: false, note: null, verdict: null,
    } as never);
    expect(row.people.sent).toBeNull();
    expect(row.delivery).toBe("unconfirmed");
  });

  it("the outcome email does not say sent", () => {
    const a = { outcome: "sent", subject: "Launch", listName: "test", sent: 5, total: null, reason: null, cardUrl: "https://x.test", byAutopilot: true, acceptedBy: "SendGrid" } as const;
    const line = emailSendOutcomeLine(a);
    expect(line).toMatch(/^SendGrid accepted your email "Launch" for a list of 5 people, "test"\. Delivery is not confirmed yet/);
    expect(line).not.toMatch(/\bsent\b/);
    const r = renderEmailSendOutcomeEmail(a);
    expect(r.subject).toBe("Accepted, not confirmed: Launch");
    expect(r.html).not.toMatch(/was <em>sent/);
    expect(r.html).toContain("handed this email to SendGrid");
  });

  it("telling the founder about a SendGrid card and a Klaviyo or Mailchimp card all use the accepted wording", async () => {
    const told = async (tool: string) => {
      const lines: string[] = [];
      const subjects: string[] = [];
      await tellEmailSendOutcome({ tenant_id: T, rail: "channel_actions", card_id: "c1", outcome: "sent", sent: 5 }, {
        readCard: async () => ({ body: { tool, list_name: "test", chosen_variant: 1, variants: [{ content: { subject: "Launch" } }] }, approved_by: "u1", approved_by_source: null }),
        claim: async (_t, _r, _i, _o, line) => { lines.push(line); return true; },
        emailOf: async () => "founder@brightloop.test",
        send: async (_to, subject) => { subjects.push(subject); },
      });
      return { line: lines[0], subject: subjects[0] };
    };
    expect(await told("sendgrid")).toMatchObject({ subject: "Accepted, not confirmed: Launch", line: expect.stringMatching(/^SendGrid accepted your email/) });
    for (const [tool, label] of [["mailchimp", "Mailchimp"], ["klaviyo", "Klaviyo"]]) {
      expect(await told(tool)).toMatchObject({ subject: "Accepted, not confirmed: Launch", line: expect.stringMatching(new RegExp(`^${label} accepted your email`)) });
    }
  });

  it("Mailchimp's outcome email still says sent", () => {
    expect(renderEmailSendOutcomeEmail({ outcome: "sent", subject: "L", listName: "t", sent: 5, total: null, reason: null, cardUrl: "https://x.test", byAutopilot: false }).subject).toBe("Sent: L");
  });

  it("Autopilot's note line does not claim a SendGrid send went out", () => {
    const line = autopilotSendLine({ action_id: "a", tool: "sendgrid", subject: "Launch", audience_name: "test", sent_to: 5, url: null });
    expect(line).not.toMatch(/Autopilot sent|5 people/);
    expect(line).toMatch(/Delivery is not confirmed yet/);
  });
});

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });

describe("a Klaviyo send that skipped people", () => {
  beforeEach(() => resetKlaviyoMetricCache());
  const sentView = (tool: string) => ({ ok: true, class: "email_campaign.create_and_send", body: { tool }, open: false, status: "approved", retryable: false }) as never;
  const facts = (h1: Record<string, unknown>) => ({ card: { status: "approved", exec_status: "executed", approved: true, executed_at: "2026-11-02T06:00:00Z", receipt: { line: "Klaviyo accepted this send for a list of 4 people. Delivery is not confirmed yet" } }, bulk: null, results: { h1, d7: null, d7_published: false } }) as never;

  it("1 of 4: the card says 1 reached and names the 3 skipped, never 4", () => {
    const s = cardSendState("channel_actions", sentView("klaviyo"), facts({ received: 1, skipped: 3 }));
    expect(s).toMatchObject({ status: "sent", delivery: "reached", sent_count: 1, skipped_count: 3 });
    expect(s.failure_reason).toBe("Klaviyo skipped 3 of 4 people, so 1 person received it. Check the skipped addresses in Klaviyo.");
  });

  it("4 of 4 skipped: nobody received it, in Klaviyo's words, not SendGrid's", () => {
    const s = cardSendState("channel_actions", sentView("klaviyo"), facts({ received: 0, skipped: 4 }));
    expect(s).toMatchObject({ delivery: "nobody", sent_count: 0, skipped_count: 4 });
    expect(s.failure_reason).toMatch(/^Klaviyo accepted this send but skipped all 4 people/);
    expect(s.failure_reason).not.toMatch(/SendGrid/);
  });

  it("before any read the send is accepted, with no sent number at all", () => {
    for (const tool of ["klaviyo", "mailchimp"]) {
      const s = cardSendState("channel_actions", sentView(tool), facts({}));
      expect(s).toMatchObject({ delivery: "unconfirmed", sent_count: null });
    }
  });

  it("day 7 events replace the 1-hour ones", () => {
    expect(deliveryOf("klaviyo", { received: 0, skipped: 2 }, { received: 3, skipped: 1 })).toEqual({ state: "reached", people: 3, skipped: 1 });
  });

  it("a Mailchimp report with people reaches them with no skip line", () => {
    const d = deliveryOf("mailchimp", { recipients: 412, delivered: 400 }, null);
    expect(d).toEqual({ state: "reached", people: 412 });
    expect(deliveryReason("mailchimp", d)).toBeNull();
  });

  it("the results list carries the honest count, the line and the skips, while the stored sent_count stays 4", () => {
    const row = rowFromResult({ rail: "channel_actions", card_id: "c", route: "klaviyo", subject: "s", list_id: "L", list_name: "Zavi QA", sent_count: 4, total_count: null, started_at: "2026-11-02T06:00:00Z", finished_at: "2026-11-02T06:00:00Z", h1: { received: 1, skipped: 3 }, d7: {}, d7_published_at: null } as never, Date.parse("2026-11-02T08:00:00Z"), "UTC");
    expect(row).toMatchObject({ people: { sent: 1 }, delivery: "reached", delivery_skipped: 3, delivery_reason: expect.stringContaining("skipped 3 of 4") });
  });

  const GOOD_EVENING = "01M6E4X442KB1NBPP0D15Z09JN";
  const HAPPY_DIWALI = "01M6E3H1ECZN95F239CXVYRJJZ";
  const GOOD_EVENING_ROW = {
    groupings: { campaign_id: GOOD_EVENING, campaign_message_id: GOOD_EVENING, send_channel: "email" },
    statistics: { click_rate: 0, clicks_unique: 0, delivered: 1, open_rate: 0, opens_unique: 0, recipients: 1, unsubscribe_uniques: 0 },
  };
  const klaviyo = (events: { received: Record<string, number> | "fails"; skipped: Record<string, number> }, rows: (timeframe: unknown) => unknown[]) => async (slug: string, args: Record<string, unknown>) => {
    if (slug === "KLAVIYO_GET_METRICS") return ok({ data: [{ id: "M1", attributes: { name: "Received Email" } }, { id: "SK", attributes: { name: "Skipped Send" } }] });
    if (slug === "KLAVIYO_QUERY_METRIC_AGGREGATES") {
      const byId = args.data__attributes__metric__id === "SK" ? events.skipped : events.received;
      if (byId === "fails") return { ok: false, error: "boom" } as never;
      return ok({ data: { attributes: { data: Object.entries(byId).map(([id, n]) => ({ dimensions: [id], measurements: { count: [n] } })) } } });
    }
    return ok({ data: { attributes: { results: rows(args.data__attributes__timeframe) } } });
  };
  const pass = async (call: unknown, ref: string) => {
    const done: Completion[] = [];
    await runEmailResultsPass({
      claim: async () => [{ ...task("klaviyo"), provider_ref: ref }],
      complete: async (_t: unknown, c: Completion) => { done.push(c); },
      providerAccess: async () => ({ kind: "ok", call: call as never, sameCredential: true, cacheKey: "k-skip" }),
      bulkCounts: async () => null, gaCreds: async () => null, gaReport: async () => ({}), missing: async () => [], start: async () => ({ started: false }),
      holdRepair: async () => undefined, backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }), purgeEventIds: async () => 0, alertStuck: async () => undefined,
      log: async () => undefined, now: () => NOW,
    } as unknown as CheckDeps);
    return done;
  };

  it("Good evening, sent this month: Klaviyo's last_12_months leaves it out, the 1-hour check still reads its numbers", async () => {
    const call = klaviyo({ received: { [GOOD_EVENING]: 1 }, skipped: {} }, (timeframe) => ((timeframe as { key?: string }).key === "last_12_months" ? [] : [GOOD_EVENING_ROW]));
    const [c] = await pass(call, GOOD_EVENING);
    expect(c).toEqual({ outcome: "done", result: { recipients: 1, delivered: 1, bounces: null, opens: 0, clicks: 0, unsubscribes: 0, received: 1, skipped: 0 } });
  });

  it("received but missing from the values report: not finished, tried again, and the event counts travel with the retry", async () => {
    const [c] = await pass(klaviyo({ received: { [GOOD_EVENING]: 1 }, skipped: {} }, () => []), GOOD_EVENING);
    expect(c.outcome).toBe("retry");
    expect(c.next_due).toEqual(new Date(NOW.getTime() + 10 * 60_000));
    expect(c.error).toBe("Klaviyo reported no numbers for this campaign yet");
    expect(c.result).toMatchObject({ received: 1, skipped: 0, delivered: null, opens: null });
  });

  it("1 received, 3 skipped, missing from the report: tried again; once the report has it, both signals finish together", async () => {
    const events = { received: { [GOOD_EVENING]: 1 }, skipped: { [GOOD_EVENING]: 3 } };
    expect((await pass(klaviyo(events, () => []), GOOD_EVENING))[0].outcome).toBe("retry");
    const [later] = await pass(klaviyo(events, () => [GOOD_EVENING_ROW]), GOOD_EVENING);
    expect(later).toMatchObject({ outcome: "done", result: { delivered: 1, opens: 0, received: 1, skipped: 3 } });
    expect(deliveryOf("klaviyo", later.result, null)).toEqual({ state: "reached", people: 1, skipped: 3 });
  });

  it("Happy Diwali, everyone skipped: Klaviyo never reports it, so it finishes as nobody reached instead of retrying for a week", async () => {
    const [c] = await pass(klaviyo({ received: {}, skipped: { [HAPPY_DIWALI]: 1 } }, () => []), HAPPY_DIWALI);
    expect(c).toMatchObject({ outcome: "done", result: { received: 0, skipped: 1 } });
    expect(deliveryOf("klaviyo", c.result, null)).toEqual({ state: "nobody", people: 0, skipped: 1 });
  });

  it("skipped people but the received read failed: nobody-reached is not proven, so it tries again", async () => {
    const [c] = await pass(klaviyo({ received: "fails", skipped: { [GOOD_EVENING]: 2 } }, () => []), GOOD_EVENING);
    expect(c.outcome).toBe("retry");
  });

  it("an account with no metric at all stays an answer, not a retry", async () => {
    const call = async () => ok({ data: [] });
    const [c] = await pass(call, GOOD_EVENING);
    expect(c.outcome).toBe("done");
  });
});
