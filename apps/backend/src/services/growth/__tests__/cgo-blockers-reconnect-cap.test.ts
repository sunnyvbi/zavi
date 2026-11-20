import { describe, it, expect } from "vitest";
import { holdRepeatReconnects, RECONNECT_ALERT_EVERY_MS, type Told } from "../cgo-blockers";

type Ranked = Parameters<typeof holdRepeatReconnects>[0][number];
const NOW = new Date("2026-10-15T15:07:00Z");
const blocker = (id: string): Ranked =>
  ({ b: { id, kind: "connector", who: "you", what: `Reconnect ${id}`, since: "2026-10-15T15:00:00Z", usd_at_stake: null }, severity: "urgent", state: "reopened" }) as unknown as Ranked;
const told = (entries: Array<[string, number]>): Map<string, Told> =>
  new Map(entries.map(([id, hoursAgo]) => [id, { severity: "urgent", usd: null, at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() }]));

describe("holdRepeatReconnects", () => {
  const reddit = blocker("ad_read_failed:b1:reddit_ads:2026-10");
  const tiktok = blocker("ad_read_failed:b1:tiktok_ads:2026-10");
  const overspend = blocker("budget_brake:b1:2026-10");

  it("Reddit at 11:08 then again at 15:07: the second waits, other alerts still go", () => {
    const out = holdRepeatReconnects([reddit, overspend], told([["ad_read_failed:b1:reddit_ads:2026-10", 4]]), NOW);
    expect(out.map((x) => x.b.id)).toEqual(["budget_brake:b1:2026-10"]);
  });

  it("a different platform breaking within the day waits for the next daily Reconnect email too", () => {
    expect(holdRepeatReconnects([tiktok], told([["ad_read_failed:b1:reddit_ads:2026-10", 4]]), NOW)).toEqual([]);
  });

  it("after a day, every channel still broken is told together", () => {
    const hours = RECONNECT_ALERT_EVERY_MS / 3_600_000 + 1;
    const out = holdRepeatReconnects([reddit, tiktok], told([["ad_read_failed:b1:reddit_ads:2026-10", hours]]), NOW);
    expect(out.map((x) => x.b.id)).toEqual([reddit.b.id, tiktok.b.id]);
  });

  it("an expired connection (connector:<slug>) is a Reconnect too: Meta at 11:08, Google at 15:07 waits", () => {
    const google = blocker("connector:google_ads");
    expect(holdRepeatReconnects([google], told([["connector:meta_ads", 4]]), NOW)).toEqual([]);
    expect(holdRepeatReconnects([reddit], told([["connector:meta_ads", 4]]), NOW)).toEqual([]);
  });

  it("nothing told before: alerts pass through unchanged", () => {
    expect(holdRepeatReconnects([reddit, overspend], new Map(), NOW)).toHaveLength(2);
  });
});
