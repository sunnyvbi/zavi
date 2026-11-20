import { describe, it, expect } from "vitest";
import { channelsDue, dueAfterMs, tripMagnitude, type ChannelState } from "../due";

const NOW = Date.parse("2026-09-02T07:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const linked = (...s: string[]) => new Set(s);
const state = (slug: string, last: string | null, priority = 100): ChannelState => ({
  channel_slug: slug,
  last_run_at: last,
  priority,
});

describe("dueAfterMs", () => {
  it("daily is 20h, not 24h, so a late cron does not drift the schedule later each day", () => {
    expect(dueAfterMs("daily")).toBe(20 * HOUR);
  });
  it("weekly and monthly", () => {
    expect(dueAfterMs("weekly")).toBe(7 * DAY);
    expect(dueAfterMs("monthly")).toBe(28 * DAY);
  });
  it("on_demand is never swept — that is what on_demand means", () => {
    expect(dueAfterMs("on_demand")).toBeNull();
    expect(dueAfterMs("whatever")).toBeNull();
  });
});

describe("channelsDue — what the sweep spends on", () => {
  it("a never-run connected channel is due", () => {
    const out = channelsDue([state("meta_ads", null)], linked("meta_ads"), NOW, 3);
    expect(out).toContain("meta_ads");
  });

  it("skips a connected channel that ran an hour ago", () => {
    const out = channelsDue([state("meta_ads", ago(HOUR))], linked("meta_ads"), NOW, 3);
    expect(out).not.toContain("meta_ads");
  });

  it("a weekly channel is NOT due at 21h", () => {
    const out = channelsDue([state("meta_ads", ago(21 * HOUR))], linked("meta_ads"), NOW, 3);
    expect(out).not.toContain("meta_ads");
  });

  it("a weekly channel is due again after 7 days", () => {
    const out = channelsDue([state("meta_ads", ago(8 * DAY))], linked("meta_ads"), NOW, 3);
    expect(out).toContain("meta_ads");
  });

  it("NEVER sweeps a channel whose connector is not linked", () => {
    const out = channelsDue([state("meta_ads", null)], linked(), NOW, 3);
    expect(out).toEqual([]);
  });

  it("NEVER sweeps TikTok Ads without its ad account: it owns no connector-free evidence", () => {
    const out = channelsDue([state("tiktok_ads", null)], linked("meta_ads"), NOW, 5);
    expect(out).not.toContain("tiktok_ads");
  });

  it("sweeps TikTok Ads weekly once its ad account is linked, like Meta", () => {
    expect(channelsDue([state("tiktok_ads", null)], linked("tiktok_ads"), NOW, 5)).toContain("tiktok_ads");
    expect(channelsDue([state("tiktok_ads", ago(3 * DAY))], linked("tiktok_ads"), NOW, 5)).not.toContain("tiktok_ads");
    expect(channelsDue([state("tiktok_ads", ago(8 * DAY))], linked("tiktok_ads"), NOW, 5)).toContain("tiktok_ads");
  });

  it("respects the per-tenant limit", () => {
    const out = channelsDue(
      [state("meta_ads", null), state("google_ads", null), state("seo", null)],
      linked("meta_ads", "google_ads", "google_analytics"),
      NOW,
      2,
    );
    expect(out).toHaveLength(2);
  });

  it("most overdue first", () => {
    const out = channelsDue(
      [
        state("meta_ads", ago(21 * HOUR)),
        state("google_ads", ago(40 * DAY)),
        state("youtube_ads", ago(HOUR)),
      ],
      linked("meta_ads", "google_ads"),
      NOW,
      2,
    );
    expect(out[0]).toBe("google_ads");
    expect(out).not.toContain("youtube_ads");
  });

  it("a never-run channel outranks one that is merely overdue", () => {
    const out = channelsDue(
      [
        state("meta_ads", ago(40 * DAY)),
        state("google_ads", ago(HOUR)),
        state("youtube_ads", null),
      ],
      linked("meta_ads", "google_ads"),
      NOW,
      1,
    );
    expect(out).toEqual(["youtube_ads"]);
  });

  it("is deterministic — the same input twice gives the same list", () => {
    const args = [
      [state("meta_ads", null), state("google_ads", null)],
      linked("meta_ads", "google_ads"),
      NOW,
      2,
    ] as const;
    expect(channelsDue(...args)).toEqual(channelsDue(...args));
  });

  it("a tenant with no channel rows still gets its connected channels", () => {
    expect(channelsDue([], linked("meta_ads"), NOW, 3)).toContain("meta_ads");
  });
});

describe("channelsDue — connector-free channels (the SEO cadence)", () => {
  it("sweeps seo with NO connector linked, when the tenant has a site to read", () => {
    const out = channelsDue([state("seo", null)], linked(), NOW, 20, true);
    expect(out).toContain("seo");
  });

  it("does NOT sweep seo when the tenant has no site on file", () => {
    const out = channelsDue([state("seo", null)], linked(), NOW, 3, false);
    expect(out).not.toContain("seo");
  });

  it("defaults to NOT sweeping — a caller that never checked cannot spend", () => {
    const out = channelsDue([state("seo", null)], linked(), NOW, 3);
    expect(out).not.toContain("seo");
  });

  it("a site on file does NOT make a connector-only channel due", () => {
    const out = channelsDue([state("meta_ads", null)], linked(), NOW, 3, true);
    expect(out).not.toContain("meta_ads");
  });

  it("still honours the cadence — a seo run 2 days ago is not due again", () => {
    const out = channelsDue([state("seo", ago(2 * DAY))], linked(), NOW, 3, true);
    expect(out).not.toContain("seo");
  });
});

describe("channelsDue — X drafts with no X account linked", () => {
  it("sweeps x_organic unconnected when the tenant has a site to write from", () => {
    expect(channelsDue([state("x_organic", null)], linked(), NOW, 50, true)).toContain("x_organic");
  });

  it("does NOT sweep it with no site on file, and not by default", () => {
    expect(channelsDue([state("x_organic", null)], linked(), NOW, 50, false)).not.toContain("x_organic");
    expect(channelsDue([state("x_organic", null)], linked(), NOW, 50)).not.toContain("x_organic");
  });

  it("the door is X only — another unconnected social channel stays on demand", () => {
    expect(channelsDue([state("linkedin_organic", null)], linked(), NOW, 50, true)).not.toContain("linkedin_organic");
  });
});

describe("channelsDue — strategy priority + trip magnitude", () => {
  const linked = new Set<string>(["google_ads", "meta_ads"]);
  const DAY = 24 * 3600_000;
  const now = Date.UTC(2026, 8, 5, 12);
  const base = (over: Partial<ChannelState> & { channel_slug: string }): ChannelState => ({
    last_run_at: new Date(now - 10 * DAY).toISOString(),
    priority: 100,
    ...over,
  });
  const rank = (out: string[], slug: string) => out.indexOf(slug);
  const before = (out: string[], a: string, b: string) => {
    expect(rank(out, a)).toBeGreaterThanOrEqual(0);
    expect(rank(out, b)).toBeGreaterThanOrEqual(0);
    expect(rank(out, a)).toBeLessThan(rank(out, b));
  };

  it("a tenant with NO strategy selects exactly what it selects today", () => {
    const states: ChannelState[] = [
      base({ channel_slug: "google_ads", last_run_at: new Date(now - 30 * DAY).toISOString() }),
      base({ channel_slug: "meta_ads", last_run_at: new Date(now - 8 * DAY).toISOString() }),
    ];
    before(channelsDue(states, linked, now, 20, false), "google_ads", "meta_ads");
  });

  it("strategy priority outranks staleness — the whole point of accepting one", () => {
    const states: ChannelState[] = [
      base({ channel_slug: "google_ads", last_run_at: new Date(now - 40 * DAY).toISOString() }),
      base({ channel_slug: "meta_ads", priority: 1 }),
    ];
    before(channelsDue(states, linked, now, 20, false), "meta_ads", "google_ads");
  });

  it("STARVATION GUARD — a tenant with no probe data still gets work", () => {
    const states: ChannelState[] = [
      base({ channel_slug: "google_ads", last_probe_delta: null }),
      base({ channel_slug: "meta_ads" }),
    ];
    const out = channelsDue(states, linked, now, 20, false);
    expect(out).toContain("google_ads");
    expect(out).toContain("meta_ads");
  });

  it("a trip NEVER gates — an unchanged channel is still selected", () => {
    const unchanged = { verdict: "unchanged" as const, signals: [] };
    const states: ChannelState[] = [
      base({ channel_slug: "google_ads", last_probe_delta: unchanged }),
      base({ channel_slug: "meta_ads", last_probe_delta: unchanged }),
    ];
    const out = channelsDue(states, linked, now, 20, false);
    expect(out).toContain("google_ads");
    expect(out).toContain("meta_ads");
  });

  it("at equal priority, the channel that MOVED more is worked first", () => {
    const moved = (pct: number) => ({
      verdict: "changed" as const,
      signals: [{ key: "k", prev: 1, now: 2, delta: pct, tripped: true }],
    });
    const states: ChannelState[] = [
      base({ channel_slug: "google_ads", last_probe_delta: moved(4) }),
      base({ channel_slug: "meta_ads", last_probe_delta: moved(61) }),
    ];
    before(channelsDue(states, linked, now, 20, false), "meta_ads", "google_ads");
  });

  it("a big move does NOT outrank the founder's stated priority", () => {
    const states: ChannelState[] = [
      base({
        channel_slug: "google_ads",
        last_probe_delta: {
          verdict: "changed",
          signals: [{ key: "k", prev: 1, now: 2, delta: 900, tripped: true }],
        },
      }),
      base({ channel_slug: "meta_ads", priority: 1 }),
    ];
    before(channelsDue(states, linked, now, 20, false), "meta_ads", "google_ads");
  });
});

describe("tripMagnitude", () => {
  it("scores every no-data shape as neutral zero, never as negative evidence", () => {
    expect(tripMagnitude(null)).toBe(0);
    expect(tripMagnitude(undefined)).toBe(0);
    expect(tripMagnitude({ verdict: "unchanged", signals: [] })).toBe(0);
    expect(tripMagnitude({ verdict: "unavailable", signals: [] })).toBe(0);
  });

  it("takes the largest tripped signal, ignoring untripped and unusable ones", () => {
    expect(
      tripMagnitude({
        verdict: "changed",
        signals: [
          { key: "a", prev: 1, now: 2, delta: 12, tripped: true },
          { key: "b", prev: 1, now: 2, delta: 44, tripped: true },
          { key: "c", prev: 1, now: 2, delta: 999, tripped: false },
          { key: "d", prev: null, now: null, delta: null, tripped: true, reason: "no_baseline" },
        ],
      }),
    ).toBe(44);
  });

  it("uses absolute movement — a big DROP is as urgent as a big rise", () => {
    expect(
      tripMagnitude({
        verdict: "changed",
        signals: [{ key: "a", prev: 100, now: 40, delta: -60, tripped: true }],
      }),
    ).toBe(60);
  });
});

describe("channelsDue — growth plan gating", () => {
  const planned = (
    slug: string,
    last: string | null,
    opts: { selected?: boolean; autorun?: boolean; order?: number | null },
  ): ChannelState => ({
    channel_slug: slug,
    last_run_at: last,
    priority: 100,
    plan_selected: opts.selected ?? false,
    autorun: opts.autorun ?? false,
    plan_sort_order: opts.order ?? null,
  });

  it("a tenant with NO live plan is unaffected — byte-identical to before", () => {
    const states = [state("meta_ads", null), state("google_ads", null)];
    const linkedBoth = linked("meta_ads", "google_ads");
    expect(channelsDue(states, linkedBoth, NOW, 3, false, false)).toEqual(
      channelsDue(states, linkedBoth, NOW, 3, false),
    );
  });

  it("never schedules a channel the founder stopped, with a live plan or without one", () => {
    const states = [
      { ...state("meta_ads", null), founder_stopped: true, autorun: true },
      state("google_ads", null),
    ];
    const both = linked("meta_ads", "google_ads");
    const noPlan = channelsDue(states, both, NOW, 3, false, false);
    expect(noPlan).toContain("google_ads");
    expect(noPlan).not.toContain("meta_ads");
    expect(
      channelsDue([{ ...planned("meta_ads", null, { selected: true, autorun: true, order: 1 }), founder_stopped: true }], both, NOW, 3, false, true),
    ).toEqual([]);
  });

  it("runs only what the plan chose AND the founder permits", () => {
    const out = channelsDue(
      [
        planned("meta_ads", null, { selected: true, autorun: true, order: 1 }),
        planned("google_ads", null, { selected: false, autorun: false }),
      ],
      linked("meta_ads", "google_ads"),
      NOW,
      3,
      false,
      true,
    );
    expect(out).toEqual(["meta_ads"]);
  });

  it("a plan-selected channel the founder switched OFF does not run", () => {
    const out = channelsDue(
      [planned("meta_ads", null, { selected: true, autorun: false, order: 1 })],
      linked("meta_ads"),
      NOW,
      3,
      false,
      true,
    );
    expect(out).toEqual([]);
  });

  it("a founder-enabled channel the plan did not select still does not auto-run", () => {
    const out = channelsDue(
      [planned("meta_ads", null, { selected: false, autorun: true })],
      linked("meta_ads"),
      NOW,
      3,
      false,
      true,
    );
    expect(out).toEqual([]);
  });

  it("orders by the plan's own ordering, not the onboarding score", () => {
    const out = channelsDue(
      [
        { ...planned("meta_ads", null, { selected: true, autorun: true, order: 2 }), priority: 1 },
        { ...planned("google_ads", null, { selected: true, autorun: true, order: 1 }), priority: 99 },
      ],
      linked("meta_ads", "google_ads"),
      NOW,
      3,
      false,
      true,
    );
    expect(out).toEqual(["google_ads", "meta_ads"]);
  });

  it("still honours the limit — a plan cannot outspend PER_TENANT_LIMIT", () => {
    const out = channelsDue(
      [
        planned("meta_ads", null, { selected: true, autorun: true, order: 1 }),
        planned("google_ads", null, { selected: true, autorun: true, order: 2 }),
      ],
      linked("meta_ads", "google_ads"),
      NOW,
      1,
      false,
      true,
    );
    expect(out).toHaveLength(1);
    expect(out).toEqual(["meta_ads"]);
  });
});

describe("channelsDue — three-tier pricing", () => {
  it("skips a channel whose executor the tier cannot run, freeing the slot", () => {
    const states = [state("meta_ads", null), state("google_ads", null)];
    const all = channelsDue(states, linked("meta_ads", "google_ads"), NOW, 3);
    expect(all).toEqual(expect.arrayContaining(["meta_ads", "google_ads"]));
    const gated = channelsDue(
      states,
      linked("meta_ads", "google_ads"),
      NOW,
      3,
      false,
      false,
      new Set(),
      (slug) => slug !== "meta_ads",
    );
    expect(gated).not.toContain("meta_ads");
    expect(gated).toContain("google_ads");
  });

  it("defaults to allow-all (gate off) so existing callers are unchanged", () => {
    const states = [state("meta_ads", null)];
    expect(channelsDue(states, linked("meta_ads"), NOW, 3)).toContain("meta_ads");
  });
});

describe("channelsDue — plan_only channels (Pinterest)", () => {
  it("never takes a plan-less tenant's unattended slot, even with a site to read", () => {
    const out = channelsDue([state("pinterest_organic", null)], linked(), NOW, 50, true);
    expect(out).not.toContain("pinterest_organic");
    expect(out).toContain("seo");
  });
});
