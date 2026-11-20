import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ projection: vi.fn() }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readCountedProjection: m.projection }));

import { CAP_UNCHECKED_WARNING, capWarningWords, createDailyUsd, withCapWarnings } from "../cap-warning";
import type { ChannelActionView } from "../channel-actions";

const P = { projected_usd: 26_800, month_cap_usd: 27_000, days_left: 10 };

describe("capWarningWords", () => {
  it("names where the month lands with the change and by how much it passes the cap", () => {
    expect(capWarningWords(P, 29.8)).toBe("This puts you on track for $27,098 this month, $98 over your $27,000 cap");
  });
  it("no warning while the month stays under the cap with it", () => {
    expect(capWarningWords(P, 10)).toBeNull();
  });
  it("an amount it cannot price warns only when the month is already over", () => {
    expect(capWarningWords(P, null)).toBeNull();
    expect(capWarningWords({ ...P, projected_usd: 27_186 }, null)).toBe("You're already on track for $27,186 this month, $186 over your $27,000 cap, and this adds to it");
  });
});

const view = (id: string, over: Partial<ChannelActionView> = {}) =>
  ({ id, executable: true, status: "pending", exec_status: null, ...over }) as ChannelActionView;
const raise = (id: string, from: number, to: number) => ({
  id,
  exec_class: "meta_ads.update_ad_set_budget",
  exec_payload: { ad_set_id: `as-${id}`, daily_budget_usd: to, expected_current_daily_budget_usd: from, over_cap: false, rationale: "Cost per booking held under target for two weeks." },
  body: {},
});

describe("withCapWarnings", () => {
  beforeEach(() => {
    m.projection.mockReset();
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { ...P, over: false } });
  });

  it("warns on a raise that carries the month past the cap; a cut and a raise that fits get nothing", async () => {
    const rows = [raise("up", 149, 178.8), raise("down", 149, 100), raise("small", 149, 150)];
    const out = await withCapWarnings("t1", [view("up"), view("down"), view("small")], rows);
    expect(out.map((v) => v.cap_warning)).toEqual(["This puts you on track for $27,098 this month, $98 over your $27,000 cap", undefined, undefined]);
    expect(m.projection).toHaveBeenCalledTimes(1);
  });

  it("a card on its way, done, or not an ad change is left alone, and no projection is read for none", async () => {
    const rows = [raise("a", 149, 178.8), raise("b", 149, 178.8), { id: "c", exec_class: null, exec_payload: null }];
    const views = [view("a", { exec_status: "queued" }), view("b", { status: "acted" }), view("c", { executable: false })];
    expect(await withCapWarnings("t1", views, rows)).toBe(views);
    expect(m.projection).not.toHaveBeenCalled();
  });

  it("a card that failed and waits for Try again still warns (an Autopilot raise refused as over_projection)", async () => {
    const out = await withCapWarnings("t1", [view("f", { exec_status: "failed" })], [raise("f", 149, 178.8)]);
    expect(out[0]!.cap_warning).toContain("$98 over your $27,000 cap");
  });

  it("must-catch: an unreadable month keeps the cards but tells the founder on each spend-adding card", async () => {
    const rows = [raise("up", 149, 178.8), raise("down", 149, 100)];
    for (const err of [new Error("ad month unreadable: meta was last read 2026-10-21"), new Error("ad_campaigns read failed: down")]) {
      m.projection.mockRejectedValueOnce(err);
      const out = await withCapWarnings("t1", [view("up"), view("down")], rows);
      expect(out.map((v) => v.cap_warning)).toEqual([CAP_UNCHECKED_WARNING, undefined]);
      expect(out.map((v) => v.id)).toEqual(["up", "down"]);
    }
    expect(CAP_UNCHECKED_WARNING).not.toMatch(/\u2014/);
  });

  it("no active budget serves the cards without a warning", async () => {
    m.projection.mockResolvedValueOnce(null);
    const views = [view("up")];
    expect(await withCapWarnings("t1", views, [raise("up", 149, 178.8)])).toBe(views);
  });
});

describe("a create adds its own daily budget", () => {
  it("reads daily_budget_usd on the payload or one level down; another currency reads nothing", () => {
    expect(createDailyUsd({ daily_budget_usd: 30 })).toBe(30);
    expect(createDailyUsd({ campaign: { name: "x" }, ad_set: { daily_budget_usd: 25 } })).toBe(25);
    expect(createDailyUsd({ daily_budget_usd: 30, currency: "INR" })).toBeNull();
    expect(createDailyUsd({ name: "no budget" })).toBeNull();
  });

  it("a pending create that would carry the month past the cap warns", async () => {
    m.projection.mockReset();
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { ...P, over: false } });
    const row = { id: "c1", exec_class: "google_ads.create_campaign", exec_payload: { daily_budget_usd: 30, location_ids: ["2840"] }, body: {} };
    const out = await withCapWarnings("t1", [view("c1")], [row]);
    expect(out[0]!.cap_warning).toBe("This puts you on track for $27,100 this month, $100 over your $27,000 cap");
  });
});

describe("a LinkedIn launch is priced by its lifetime total over the days left", () => {
  it("total_budget_usd / days left a day, the rate its monthly hold takes", async () => {
    m.projection.mockReset();
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { ...P, over: false } });
    const row = { id: "li", exec_class: "linkedin_ads.launch_campaign", exec_payload: { campaign_binding_id: "x", total_budget_usd: 600, currency: "EUR" }, body: {} };
    const out = await withCapWarnings("t1", [view("li")], [row]);
    expect(out[0]!.cap_warning).toBe("This puts you on track for $27,400 this month, $400 over your $27,000 cap");
  });

  it("a launch that fits gets no warning", async () => {
    m.projection.mockReset();
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { ...P, over: false } });
    const row = { id: "li", exec_class: "linkedin_ads.launch_campaign", exec_payload: { total_budget_usd: 100 }, body: {} };
    expect((await withCapWarnings("t1", [view("li")], [row]))[0]!.cap_warning).toBeUndefined();
  });
});
