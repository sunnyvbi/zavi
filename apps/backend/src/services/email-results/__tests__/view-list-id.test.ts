import { describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>>, selects: [] as string[] }));

vi.mock("@/services/tenant-client", () => {
  const query = (table: string) => {
    let cols: string[] = [];
    const chain = {
      select(c: string) {
        tables.selects.push(`${table}: ${c}`);
        cols = c.split(",").map((x) => x.trim());
        return chain;
      },
      in: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
        const data = (tables.rows[table] ?? []).map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]])));
        return Promise.resolve({ data, error: null }).then(ok, bad);
      },
    };
    return chain;
  };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: query }), tenantRpc: vi.fn() };
});

import { listSentEmailsPage } from "../view";

const result = (over: Record<string, unknown>) => ({
  rail: "decisions",
  card_id: "c-1",
  route: "mailchimp",
  subject: "Spring sale",
  list_id: "L1",
  list_name: "Customers",
  campaign_slug: null,
  shared_tag: false,
  sent_count: 300,
  total_count: 300,
  started_at: "2026-10-26T15:00:00Z",
  finished_at: "2026-10-26T15:05:00Z",
  win_line: {},
  h1: {},
  d7: {},
  d7_published_at: null,
  verdict: null,
  note: null,
  ...over,
});

describe("Sent emails rows name the list by id, not only by name", () => {
  it("a finished send and a Zavi-list send still going both carry the list id they went to, read from the database rows", async () => {
    tables.selects.length = 0;
    tables.rows = {
      email_send_results: [result({ card_id: "c-1", list_id: "L1", list_name: "Customers" }), result({ card_id: "c-2", list_id: "L2", list_name: "Customers" }), result({ card_id: "c-3", list_id: null, list_name: "Old" })],
      email_bulk_sends: [
        { decision_id: "d-going", status: "sending", hold_reason: null, sent: 5, total: 40, created_at: "2026-10-27T10:00:00Z", subject: "Hi", list_id: "Z1", list_version_id: "v1" },
      ],
      decisions: [{ id: "d-going", body: { list_name: "Members" } }],
    };
    const page = await listSentEmailsPage("tenant-a", 50, { zone: async () => "UTC" });
    expect(page.emails.map((e) => [e.card.id, e.route, e.list_id, e.list_name])).toEqual([
      ["d-going", "zavi_list", "Z1", "Members"],
      ["c-1", "mailchimp", "L1", "Customers"],
      ["c-2", "mailchimp", "L2", "Customers"],
      ["c-3", "mailchimp", null, "Old"],
    ]);
    expect(tables.selects.find((s) => s.startsWith("email_send_results:"))).toMatch(/\blist_id\b/);
    expect(tables.selects.find((s) => s.startsWith("email_bulk_sends:"))).toMatch(/\blist_id\b/);
    expect(tables.selects.find((s) => s.startsWith("email_bulk_sends:"))).not.toMatch(/list_version_id/);
  });
});
