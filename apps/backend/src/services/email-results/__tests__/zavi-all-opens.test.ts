import { describe, expect, it } from "vitest";
import { bulkNumbers } from "../check";
import { rowFromInFlight, rowFromResult } from "../view";

const record = (over: Record<string, unknown> = {}) => ({
  rail: "decisions",
  card_id: "22222222-2222-4222-8222-222222222222",
  route: "mailchimp",
  subject: "Launch week",
  list_id: null,
  list_name: "Newsletter",
  campaign_slug: null,
  shared_tag: false,
  sent_count: 100,
  total_count: null,
  started_at: "2026-10-12T15:00:00Z",
  finished_at: "2026-10-12T15:00:00Z",
  win_line: { metric: "visitors", threshold: 0.02, basis: "median", n_past: 4 },
  h1: { delivered: 100, opens: 40, clicks: 8, unsubscribes: 0, provider_status: "ok" },
  d7: {},
  d7_published_at: null,
  verdict: null,
  note: null,
  ...over,
});

const rateKeys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => /rate/i.test(k));

describe("Zavi's own sender: opens are every open, so the row says so and carries no rate", () => {
  it("10 delivered and 25 human opens from 4 people: the check keeps the raw count with no rate, the view labels it Opens (all) and marks it not unique", () => {
    const stage = bulkNumbers({ sent: 10, delivered: 10, opens: 25, machine_opens: 6, unsubscribes: 0, delivered_seen_at: "2026-10-12T15:10:00Z" });
    expect(stage).toMatchObject({ delivered: 10, opens: 25, machine_opens: 6 });
    expect(rateKeys(stage)).toEqual([]);

    const z = rowFromResult(record({ route: "zavi_list", sent_count: 10, h1: stage }) as never);
    expect(z.opens).toEqual({ value: 25, why: null });
    expect(z.delivered).toEqual({ value: 10, why: null });
    expect(z.opens_label).toBe("Opens (all)");
    expect(z.opens_unique).toBe(false);
    expect(rateKeys(z as unknown as Record<string, unknown>)).toEqual([]);

    const m = rowFromResult(record() as never);
    expect(m.opens_label).toBe("Opens");
    expect(m.opens_unique).toBe(true);
    expect(m.opens).toEqual({ value: 40, why: null });
  });

  it("every tool route is unique opens; a Zavi-list row is not unique at day 7 or while it is still sending", () => {
    for (const route of ["mailchimp", "klaviyo", "sendgrid"]) expect(rowFromResult(record({ route }) as never).opens_unique).toBe(true);
    const d7 = rowFromResult(record({ route: "zavi_list", d7_published_at: "2026-10-19T15:00:00Z", d7: { delivered: 10, opens: 25 }, verdict: "beat" }) as never);
    expect(d7).toMatchObject({ stage: "d7", opens_unique: false, opens_label: "Opens (all)", opens: { value: 25 } });
    const going = rowFromInFlight({ decision_id: "d1", status: "sending", hold_reason: null, sent: 4, total: 10, created_at: "2026-10-12T15:00:00Z", subject: "s", list_id: null, list_name: null });
    expect(going).toMatchObject({ opens_unique: false, opens_label: "Opens (all)" });
  });
});
