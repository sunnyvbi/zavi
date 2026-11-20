import { describe, expect, it } from "vitest";
import { bulkNumbers } from "../check";
import { cardSendState, type SendFacts, type ViewState } from "../../email-cards/cards";

const view = { status: "acted", class: "bulk_outbound.send", body: {} } as unknown as ViewState;

const facts = (stages: { h1: Record<string, unknown>; d7: Record<string, unknown>; d7_published: boolean }, liveBounces: number): SendFacts => ({
  card: { status: "executed", exec_status: "executed", approved: true, executed_at: "2026-10-20T10:05:00Z" },
  bulk: {
    status: "done", hold_reason: null, total: 100, sent: 100, skipped: 0, failed: 0, unknown: 0, hard_bounces: liveBounces,
    created_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:05:00Z", next_run_at: null,
  },
  results: { sent_count: 100, finished_at: "2026-10-20T10:05:00Z", ...stages },
});

const counts = { sent: 100, delivered: 96, opens: 40, machine_opens: 3, unsubscribes: 1, delivered_seen_at: "2026-10-20T10:20:00Z" };

describe("Zavi-list bounces are frozen at each check, like every other number", () => {
  it("the 1-hour read keeps the bounces it saw, so the day-7 row cannot drag it up", () => {
    const h1 = bulkNumbers({ ...counts, hard_bounces: 2 });
    const d7 = bulkNumbers({ ...counts, hard_bounces: 7 });
    expect(h1.bounces).toBe(2);
    expect(d7.bounces).toBe(7);
    const s = cardSendState("decisions", view, facts({ h1, d7, d7_published: true }, 9));
    expect(s.hour_1?.bounces).toBe(2);
    expect(s.day_7?.bounces).toBe(7);
    expect(s.results?.bounces).toBe(7);
  });

  it("a read before any bounce was recorded shows 0, not whatever arrives later", () => {
    const h1 = bulkNumbers({ ...counts, hard_bounces: 0 });
    const s = cardSendState("decisions", view, facts({ h1, d7: {}, d7_published: false }, 5));
    expect(s.hour_1?.bounces).toBe(0);
  });
});
