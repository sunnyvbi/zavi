import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ value: [] as unknown[], tenants: [] as string[] }));
vi.mock("@/services/email-results/view", async (orig) => {
  const real = await orig<typeof import("@/services/email-results/view")>();
  return {
    ...real,
    listSentEmails: async (tenantId: string) => {
      rows.tenants.push(tenantId);
      return rows.value;
    },
  };
});

import { rowFromInFlight, rowFromResult } from "@/services/email-results/view";
import { emailCampaignGetResultsTool } from "../get_results";

const result = (over: Record<string, unknown> = {}) =>
  rowFromResult({
    rail: "channel_actions",
    card_id: "11111111-1111-4111-8111-111111111111",
    route: "mailchimp",
    subject: "Spring update",
    list_name: "Customers",
    campaign_slug: "spring-update-20261012-abcdefghij",
    shared_tag: false,
    sent_count: 120,
    total_count: null,
    started_at: "2026-10-01T10:00:00Z",
    finished_at: "2026-10-01T10:00:00Z",
    win_line: { metric: "visitors", threshold: 0.02, basis: "median", n_past: 5 },
    h1: { delivered: 118, opens: 30, provider_status: "ok" },
    d7: { delivered: 119, opens: 60, clicks: 9, unsubscribes: 1, visitors: 4, provider_status: "ok", ga_status: "ok" },
    d7_published_at: "2026-10-08T22:00:00Z",
    verdict: "beat",
    note: null,
    ...over,
  } as never);

describe("email_campaign_get_results", () => {
  it("day-7 numbers with the win line and verdict, for this workspace only", async () => {
    rows.value = [result()];
    const out = (await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})) as { emails: Array<Record<string, unknown>> };
    expect(rows.tenants.at(-1)).toBe("t1");
    expect(out.emails[0]).toMatchObject({
      sent_with: "Mailchimp",
      as_of: "d7",
      delivered: 119,
      clicks: 9,
      visitors: 4,
      win_line: "2.0% of delivered visit your site",
      day_7: "Beat the win line",
    });
    expect(JSON.stringify(out)).not.toContain("provider_ref");
  });

  it("a Mailchimp row tells the agent the delivered number is not inbox proof; another route's does not", async () => {
    rows.value = [result(), result({ route: "klaviyo" })];
    const out = (await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})) as { emails: Array<Record<string, unknown>> };
    expect(out.emails[0].delivered).toBe(119);
    expect(out.emails[0].delivered_means).toMatch(/did not bounce.*do not say it arrived/i);
    expect(out.emails[1]).not.toHaveProperty("delivered_means");
  });

  it("before day 7: the 1-hour numbers, labelled, and when day 7 is due", async () => {
    rows.value = [result({ d7_published_at: null, verdict: null, d7: {} })];
    const out = (await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})) as { emails: Array<Record<string, unknown>> };
    expect(out.emails[0]).toMatchObject({ as_of: "h1", delivered: 118, opens: 30, day_7: "due 2026-10-08" });
    expect((out.emails[0].missing as Record<string, string>).clicks).toBe("Mailchimp does not report this");
  });

  it("a Zavi-list send still going says so; GA not connected says to connect it", async () => {
    rows.value = [
      rowFromInFlight({ decision_id: "d1", status: "waiting_for_tomorrow", hold_reason: null, sent: 300, total: 900, created_at: "2026-10-12T10:00:00Z", subject: "Hi", list_id: null, list_name: "Members" }),
      result({ route: "zavi_list", d7: { delivered: 50, opens: 20, unsubscribes: 0, provider_status: "ok", ga_status: "not_connected", visitors: null }, verdict: "unknown" }),
    ];
    const out = (await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})) as { emails: Array<Record<string, unknown>> };
    expect(out.emails[0]).toMatchObject({ status: "Sending, 300 of 900 so far", as_of: null });
    expect(out.emails[1]).toMatchObject({ sent_with: "Zavi", visitors: null, clicks: null });
    expect((out.emails[1].missing as Record<string, string>).visitors).toBe("Connect Google Analytics");
  });

  describe("numbers carried from the 1-hour check", () => {
    const CARRIED = JSON.parse('{"opens":0,"clicks":2,"from_h1":["recipients","delivered","opens","clicks","unsubscribes"],"delivered":5,"recipients":5,"unsubscribes":0,"provider_status":"could_not_read"}');
    const clicksLine = { metric: "clicks", threshold: 0.02, basis: "median", n_past: 5 };
    const read = async () => ((await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})) as { emails: Array<Record<string, unknown>> }).emails[0];

    it("a could-not-read carry with no stored note is flagged, and the stored beat is gone", async () => {
      rows.value = [result({ win_line: clicksLine, d7: CARRIED, verdict: "beat", note: null })];
      const out = await read();
      expect(out).toMatchObject({
        as_of: "h1",
        clicks: 2,
        from_1_hour: ["delivered", "opens", "clicks", "unsubscribes"],
        note: "Mailchimp could not be read; numbers stopped at 1 hour.",
        day_7: "Numbers stopped at 1 hour: not judged",
      });
      expect(JSON.stringify(out)).not.toMatch(/beat/i);
    });

    it("a disconnected rerun with real numbers drops the stale note and keeps its verdict", async () => {
      rows.value = [result({ win_line: clicksLine, d7: { delivered: 5, opens: 3, clicks: 1, unsubscribes: 0, provider_status: "disconnected" }, verdict: "beat", note: "Mailchimp was disconnected; numbers stopped at 1 hour." })];
      expect(await read()).toMatchObject({ as_of: "d7", from_1_hour: [], note: null, day_7: "Beat the win line" });
    });

    it("only unsubscribes carried: the verdict stands and that one number is named", async () => {
      rows.value = [result({ win_line: clicksLine, d7: { delivered: 5, opens: 3, clicks: 1, unsubscribes: 0, from_h1: ["unsubscribes"], provider_status: "disconnected" }, verdict: "beat" })];
      expect(await read()).toMatchObject({ as_of: "d7", from_1_hour: ["unsubscribes"], note: "Mailchimp was disconnected; numbers stopped at 1 hour.", day_7: "Beat the win line" });
    });
  });

  it("nothing sent yet: an empty list", async () => {
    rows.value = [];
    expect(await emailCampaignGetResultsTool.execute({ tenant_id: "t1" } as never, {})).toEqual({ count: 0, emails: [] });
  });
});
