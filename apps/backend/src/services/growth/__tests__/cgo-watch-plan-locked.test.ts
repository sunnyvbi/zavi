
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pending: [] as Array<Record<string, unknown>>,
  recent: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      let pendingOnly = false;
      const self: Record<string, unknown> = {};
      for (const m of ["select", "gte", "order", "limit", "not", "or", "in", "neq"]) self[m] = () => self;
      self.eq = (k: string, v: unknown) => {
        if (table === "channel_actions" && k === "status" && v === "pending") pendingOnly = true;
        return self;
      };
      self.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "channel_actions" ? (pendingOnly ? h.pending : h.recent) : [],
          error: null,
          count: 0,
        }).then(resolve);
      return self;
    },
  }),
}));
vi.mock("../channel-autorun", async (orig) => ({
  ...(await orig<typeof import("../channel-autorun")>()),
  readAutopilotState: vi.fn(async () => null),
}));

import { computeAlarms, readWatchState, withoutPlanLockedCards, type WatchState } from "../cgo-watch";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const NOW = new Date("2026-10-13T14:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const card = (id: string, channel_slug: string, status = "pending") => ({ id, channel_slug, status, proposed_at: daysAgo(6) });

beforeEach(() => {
  resetTenantPlan();
  h.pending = [card("a1", "seo"), card("a2", "seo"), card("a3", "reddit_organic")];
  h.recent = [...h.pending, card("a4", "seo", "acted")];
});

const quiet = (s: WatchState): WatchState => ({
  ...s,
  notes: [
    {
      id: "n1",
      kind: "scheduled",
      saw: [],
      changed: [],
      would_change: [],
      need: [],
      alarm_keys: [],
      next_review_at: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
      created_at: daysAgo(1),
    } as WatchState["notes"][number],
  ],
  founder_last_active_at: daysAgo(1),
});

describe("readWatchState and a plan-locked channel", () => {
  it("Free: first-round cards are not in the watch state, so nothing wakes cgo", async () => {
    tenantPlan.tier = "free";
    const s = await readWatchState(T, NOW);
    expect(s.pending).toEqual([]);
    expect(s.recent.map((a) => a.id)).toEqual(["a4"]);
    expect(computeAlarms(quiet(s), NOW)).toMatchObject({ wake: false, reasons: [], keys: [] });
  });

  it("Starter: the same cards are watched as before, and untouched ones raise the alarm", async () => {
    tenantPlan.tier = "starter";
    const s = await readWatchState(T, NOW);
    expect(s.pending.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(s.recent.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(computeAlarms(quiet(s), NOW).reasons).toEqual(["cards_untouched"]);
  });

  it("only the locked channel's cards are dropped: a Starter workspace keeps seo and loses a Pro channel's", async () => {
    tenantPlan.tier = "starter";
    h.pending = [card("a1", "seo"), card("m1", "meta_ads")];
    h.recent = [...h.pending];
    const s = await readWatchState(T, NOW);
    expect(s.pending.map((a) => a.id)).toEqual(["a1"]);
    expect(s.recent.map((a) => a.id)).toEqual(["a1"]);
  });

  it("an unreadable plan keeps the cards OUT (never fails open to waking cgo)", async () => {
    tenantPlan.tier = "pro";
    tenantPlan.unreadable = true;
    const s = await readWatchState(T, NOW);
    expect(s.pending).toEqual([]);
  });
});

describe("withoutPlanLockedCards", () => {
  it("resolves the plan once for all the slugs, and not at all when nothing is open", async () => {
    const loadConfig = vi.fn(async () => ({ enforced: false, agentMin: { seo: "starter" as const, geo: "starter" as const }, proTenants: [], alwaysPro: [] }));
    const resolveTier = vi.fn(async () => "free" as const);
    const out = await withoutPlanLockedCards(T, [card("a1", "seo"), card("a2", "geo"), card("a3", "seo")], [], { loadConfig, resolveTier });
    expect(out.pending).toEqual([]);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveTier).toHaveBeenCalledTimes(1);

    loadConfig.mockClear();
    const none = await withoutPlanLockedCards(T, [], [card("r1", "seo", "acted")], { loadConfig, resolveTier });
    expect(none.recent).toHaveLength(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
