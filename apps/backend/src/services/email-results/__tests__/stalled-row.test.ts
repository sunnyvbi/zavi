import { describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>>, reads: [] as string[] }));

vi.mock("@/services/tenant-client", () => {
  const query = (table: string) => {
    let cols: string[] = [];
    const filters: Array<[string, unknown[]]> = [];
    const chain = {
      select(c: string) {
        cols = c.split(",").map((x) => x.trim());
        return chain;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, vals]);
        return chain;
      },
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
        tables.reads.push(`${table}: ${filters.map(([c]) => c).join(",")}`);
        const data = (tables.rows[table] ?? [])
          .filter((r) => filters.every(([c, v]) => v.includes(r[c])))
          .map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]])));
        return Promise.resolve({ data, error: null }).then(ok, bad);
      },
    };
    return chain;
  };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: query }), tenantRpc: vi.fn(), opsRpc: vi.fn() };
});

import { listSentEmailsPage } from "../view";
import { FANOUT_STALLED_REASON } from "@/services/email-cards/recovery";
import { emailCampaignGetResultsTool } from "@/services/tools/email-campaign/get_results";

const result = (over: Record<string, unknown>) => ({
  rail: "decisions",
  card_id: "d-stalled",
  route: "zavi_list",
  subject: "Spring sale",
  list_id: "Z1",
  list_name: "Members",
  campaign_slug: null,
  shared_tag: false,
  sent_count: 1,
  total_count: 3,
  started_at: "2026-10-28T09:00:00Z",
  finished_at: "2026-10-28T10:00:00Z",
  win_line: {},
  h1: {},
  d7: {},
  d7_published_at: null,
  verdict: null,
  note: null,
  ...over,
});

const bulk = (over: Record<string, unknown>) => ({ decision_id: "d-stalled", status: "held", hold_reason: "fanout_stalled", sent: 1, total: 3, created_at: "2026-10-28T09:00:00Z", subject: "Spring sale", list_id: "Z1", ...over });

const STALLED_NOTE = `${FANOUT_STALLED_REASON} 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.`;

describe("Bug 81ac: the Campaigns row of a bulk send the recovery sweep gave up on", () => {
  it("is one row that carries the stalled reason and how many were not emailed, while a clean send and a send still going carry none", async () => {
    tables.reads.length = 0;
    tables.rows = {
      email_send_results: [
        result({}),
        result({ card_id: "d-done", sent_count: 40, total_count: null }),
        result({ card_id: "c-tool", rail: "channel_actions", route: "mailchimp", sent_count: 5, total_count: 9 }),
      ],
      email_bulk_sends: [bulk({}), bulk({ decision_id: "d-done", status: "done", hold_reason: null }), bulk({ decision_id: "d-going", status: "sending", hold_reason: null, sent: 2, total: 50 })],
      decisions: [{ id: "d-going", body: { list_name: "Members" } }],
    };
    const page = await listSentEmailsPage("tenant-a", 50, { zone: async () => "UTC" });
    const ids = page.emails.map((e) => e.card.id);
    expect(ids).toEqual(["d-going", "d-stalled", "d-done", "c-tool"]);
    const stalled = page.emails.find((e) => e.card.id === "d-stalled")!;
    expect(stalled.stop_note).toBe(STALLED_NOTE);
    expect(stalled.people).toEqual({ sent: 1, total: 3, stopped: true });
    expect(page.emails.filter((e) => e.card.id !== "d-stalled").map((e) => e.stop_note)).toEqual([null, null, null]);
    expect(tables.reads.filter((r) => r === "email_bulk_sends: decision_id")).toHaveLength(1);
  });

  it("a resumable hold is not called stopped, and the agent's results tool reads the stalled note as the status", async () => {
    tables.rows = {
      email_send_results: [result({}), result({ card_id: "d-paused" })],
      email_bulk_sends: [bulk({}), bulk({ decision_id: "d-paused", hold_reason: "abuse_bounces" })],
      decisions: [],
    };
    const page = await listSentEmailsPage("tenant-a", 50, { zone: async () => "UTC" });
    expect(page.emails.find((e) => e.card.id === "d-paused" && e.stage !== "paused")?.stop_note).toBeNull();
    const out = (await emailCampaignGetResultsTool.execute({ tenant_id: "tenant-a" } as never, {} as never)) as { emails: Array<{ status: string | null; stopped_after: string | null }> };
    expect(out.emails.map((e) => e.status)).toContain(STALLED_NOTE);
  });
});
