
import { describe, it, expect, vi } from "vitest";

vi.mock("../unattended-policy", () => ({ loadPausedByFounder: vi.fn() }));

import { cgoPauseHolds, statusEventOf, holdKey, CGO_PAUSE_HOLD_DAYS, type StatusEvent } from "../cgo-pause-hold";
import { dwellKeyOf, heldByCgoPause, planCreatives, planGapOrders, type AdObject, type Inventory } from "../ad-spend-controller";
import type { SpendPace } from "@/services/growth/spend-pace";

const NOW = new Date("2026-10-10T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const ev = (object_id: string, d: number, paused: boolean, by: StatusEvent["by"], platform: StatusEvent["platform"] = "meta"): StatusEvent => ({
  platform,
  object_id,
  at: daysAgo(d),
  paused,
  by,
});

describe("cgoPauseHolds: who paused it last", () => {
  it("must catch: cgo paused an ad set 12 days ago and it was resumed outside Zavi since", () => {
    const held = cgoPauseHolds([ev("cleaning-competitor-angle", 12, true, "cgo")], NOW);
    expect(held.has(holdKey("meta", "cleaning-competitor-angle"))).toBe(true);
  });

  it("must catch: the controller cutting a loser counts as Autopilot's pause", () => {
    expect(cgoPauseHolds([ev("signup-broad", 3, true, "controller")], NOW).has("meta:signup-broad")).toBe(true);
  });

  it("must catch: the controller's own switch-on after cgo's pause does not clear it", () => {
    const held = cgoPauseHolds([ev("as1", 9, true, "cgo"), ev("as1", 2, false, "controller")], NOW);
    expect(held.has("meta:as1")).toBe(true);
  });

  it("must catch on Google too", () => {
    expect(cgoPauseHolds([ev("9001", 5, true, "cgo", "google")], NOW).has("google:9001")).toBe(true);
  });

  it("must not catch: the pause is older than the hold window", () => {
    expect(cgoPauseHolds([ev("as1", CGO_PAUSE_HOLD_DAYS + 1, true, "cgo")], NOW).size).toBe(0);
  });

  it("must not catch: the founder resumed it in Zavi after cgo's pause", () => {
    expect(cgoPauseHolds([ev("as1", 10, true, "cgo"), ev("as1", 4, false, "person")], NOW).size).toBe(0);
  });

  it("must not catch: cgo itself resumed it", () => {
    expect(cgoPauseHolds([ev("as1", 10, true, "cgo"), ev("as1", 4, false, "cgo")], NOW).size).toBe(0);
  });

  it("must not catch: the founder paused it (their own pause is handled by loadPausedByFounder)", () => {
    expect(cgoPauseHolds([ev("as1", 2, true, "person")], NOW).size).toBe(0);
  });

  it("must not catch: Zavi's own paused launch has no pause on record", () => {
    expect(cgoPauseHolds([], NOW).size).toBe(0);
  });
});

describe("statusEventOf", () => {
  it("reads the actor from the approval source and the controller's origin stamp", () => {
    const base = { cls: "meta_ads.set_status", body: { object_id: "as1", status: "PAUSED" }, at: daysAgo(1) };
    expect(statusEventOf({ ...base, approved_by_source: "cgo" })?.by).toBe("cgo");
    expect(statusEventOf({ ...base, approved_by_source: "cgo", origin: "ad_spend_controller" })?.by).toBe("controller");
    expect(statusEventOf({ ...base, approved_by_source: null })?.by).toBe("person");
    expect(statusEventOf({ ...base, approved_by_source: "cgo" })?.paused).toBe(true);
  });

  it("takes the id the body's level names, not a child id it also carries", () => {
    const e = statusEventOf({ cls: "google_ads.set_status", body: { level: "campaign", campaign_id: "100", ad_group_id: "200", status: "PAUSED" }, at: daysAgo(1), approved_by_source: "cgo" });
    expect(e).toMatchObject({ platform: "google", object_id: "100" });
  });

  it("takes the most specific Google id when no level is given", () => {
    const e = statusEventOf({ cls: "google_ads.set_status_review", body: { campaign_id: "1", ad_group_id: "2", status: "PAUSED" }, at: daysAgo(1), approved_by_source: "cgo" });
    expect(e).toMatchObject({ platform: "google", object_id: "2" });
  });

  it("ignores a body with no id or an unknown platform", () => {
    expect(statusEventOf({ cls: "meta_ads.set_status", body: { status: "PAUSED" }, at: daysAgo(1), approved_by_source: "cgo" })).toBeNull();
    expect(statusEventOf({ cls: "email.set_status", body: { object_id: "x" }, at: daysAgo(1), approved_by_source: "cgo" })).toBeNull();
  });
});

function adSet(id: string, over: Partial<AdObject> = {}): AdObject {
  return {
    platform: "meta",
    level: "ad_set",
    id,
    campaign_id: "camp-1",
    name: `Ad set ${id}`,
    active: true,
    paused_self: false,
    parent_active: true,
    daily_budget_usd: 20,
    budget_on_campaign: false,
    spend7d_usd: 140,
    spend3d_usd: 60,
    spend_days7d: 7,
    results7d: 7,
    result_kind: "conversions",
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}
const inv = (meta: AdObject[], google: AdObject[] = []): Inventory => ({
  meta: { connected: true, objects: meta, ads: [] },
  google: { connected: google.length > 0, objects: google, conversions30d: google.length ? 10 : null },
});
const BEHIND: SpendPace = {
  daily_target_usd: 600,
  required_cumulative_usd: 6000,
  actual_month_usd: 3000,
  delivery_debt_usd: 3000,
  days_left: 20,
  data_fresh: true,
} as SpendPace;
const plan = (objects: Inventory, extra: { held?: string[]; enableSafe?: string[] } = {}) =>
  planGapOrders({
    pace: BEHIND,
    inv: objects,
    now: NOW,
    dwell: new Set(),
    recentlyOrdered: new Set(),
    enableSafe: new Set(extra.enableSafe ?? []),
    held: new Set(extra.held ?? []),
  });

describe("planGapOrders with Autopilot-paused objects held", () => {
  it("must catch (home-cleaning service): a held delivering ad set is never raised or copied; the others are", () => {
    const objects = inv([adSet("deep-clean-promo"), adSet("move-out-special")]);
    const p = plan(objects, { held: [dwellKeyOf("meta", "deep-clean-promo")] });
    const touched = p.orders.map((o) => o.body.ad_set_id ?? o.body.source_ad_set_id);
    expect(touched).not.toContain("deep-clean-promo");
    expect(touched).toContain("move-out-special");
  });

  it("must not catch: without a hold the same ad set is raised", () => {
    const p = plan(inv([adSet("deep-clean-promo"), adSet("move-out-special")]));
    expect(p.orders.filter((o) => o.exec_class === "meta_ads.update_ad_set_budget").map((o) => o.body.ad_set_id)).toContain("deep-clean-promo");
  });

  it("must catch (SaaS): a held paused ad set is not switched on, Zavi's own paused launch still is", () => {
    const cut = adSet("free-trial-broad", { active: false, paused_self: true });
    const launch = adSet("free-trial-lookalike", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0 });
    const p = plan(inv([cut, launch]), {
      enableSafe: [dwellKeyOf("meta", "free-trial-broad"), dwellKeyOf("meta", "free-trial-lookalike")],
      held: [dwellKeyOf("meta", "free-trial-broad")],
    });
    const switchedOn = p.orders.filter((o) => o.exec_class === "meta_ads.set_status").map((o) => o.body.object_id);
    expect(switchedOn).toEqual(["free-trial-lookalike"]);
  });

  it("must catch: a held Google campaign is not raised", () => {
    const g = adSet("4401", { platform: "google", level: "campaign", campaign_id: "4401" });
    const p = plan(inv([], [g]), { held: [dwellKeyOf("google", "4401")] });
    expect(p.orders.some((o) => o.body.campaign_id === "4401")).toBe(false);
  });
});

describe("heldByCgoPause", () => {
  const log = vi.fn();
  it("holds the object, and an ad set under a held campaign", async () => {
    const objects = inv([adSet("a", { campaign_id: "camp-held" }), adSet("b", { campaign_id: "camp-ok" }), adSet("c", { campaign_id: "camp-ok" })]);
    const held = await heldByCgoPause("t1", objects, NOW, { cgoPauseHolds: async () => new Set([holdKey("meta", "camp-held"), holdKey("meta", "c")]), log });
    expect([...held.keys].sort()).toEqual([dwellKeyOf("meta", "a"), dwellKeyOf("meta", "c")]);
    expect(held.unread).toBe(false);
  });

  it("unreadable holds every object: nothing grows this hour", async () => {
    const objects = inv([adSet("a"), adSet("b")]);
    const held = await heldByCgoPause("t1", objects, NOW, {
      cgoPauseHolds: async () => {
        throw new Error("db down");
      },
      log,
    });
    expect(held.keys.size).toBe(2);
    expect(held.unread).toBe(true);
    expect(log).toHaveBeenCalledWith("t1", "cgo.spend_controller_pause_holds_unread", expect.stringContaining("db down"));
  });
});

describe("planCreatives skips a held live ad set", () => {
  const deps = {
    fatiguedAdSets: async () => new Set<string>(),
    readCreativeCopy: async (id: string) => ({ source_ad_id: `${id}-ad`, primary_text: "Book a weekly clean.", headline: "Weekly clean", link_url: "https://fernway-cleaning.example/book" }),
    generateImage: async () => "https://cdn.example/img.png",
  };
  it("must catch: no new ad goes into a held ad set; an unheld one in another campaign still gets one", async () => {
    const objects = inv([adSet("120000000401", { campaign_id: "c-held" }), adSet("120000000402", { campaign_id: "c-ok" })]);
    const r = await planCreatives({ inv: objects, now: NOW, dwell: new Set(), held: new Set([dwellKeyOf("meta", "120000000401")]) }, deps);
    const targets = r.orders.map((o) => o.body.ad_set_id);
    expect(targets).not.toContain("120000000401");
    expect(targets).toContain("120000000402");
  });
});
