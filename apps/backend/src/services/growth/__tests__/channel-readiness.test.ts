import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { channelReadiness } from "../channel-readiness";
import { channelsDue, type ChannelState } from "@/services/channels/due";

const NONE: ReadonlySet<string> = new Set();

describe("channelReadiness", () => {
  it("reports a channel runnable when one of its declared connectors is linked", () => {
    const ch = CHANNELS.find((c) => c.connectors.length > 0)!;
    const r = channelReadiness(ch.slug, new Set<string>([ch.connectors[0]!]), false);
    expect(r.runnable).toBe(true);
    expect(r.reason).toBe("runnable");
    expect(r.connect).toEqual([]);
  });

  it("names the connectors that would unblock a blocked channel", () => {
    const ch = CHANNELS.find((c) => c.connectors.length > 0)!;
    const r = channelReadiness(ch.slug, NONE, true);
    if (r.reason === "needs_connector") {
      expect(r.runnable).toBe(false);
      expect(r.connect.length).toBeGreaterThan(0);
      expect(channelReadiness(ch.slug, new Set<string>([r.connect[0]!]), false).runnable).toBe(true);
    }
  });

  it("treats a connector-free channel as runnable once a site is on file", () => {
    expect(channelReadiness("seo", NONE, true).runnable).toBe(true);
    const without = channelReadiness("seo", NONE, false);
    expect(without.runnable).toBe(false);
    expect(without.reason).toBe("needs_site");
    expect(without.connect).toEqual([]);
  });

  it("flags an invented channel rather than sending the founder after a connector", () => {
    const r = channelReadiness("growth_hacking_synergy", NONE, true);
    expect(r.reason).toBe("unknown_channel");
    expect(r.connect).toEqual([]);
  });

  it("treats a draft-from-site channel as runnable with no connector linked", () => {
    const r = channelReadiness("x_organic", NONE, true);
    expect(r.runnable).toBe(true);
    expect(r.reason).toBe("runnable");
    expect(r.connect).toEqual([]);
  });

  it("asks for the site, not a connector, when there is nothing to draft from", () => {
    const r = channelReadiness("x_organic", NONE, false);
    expect(r.runnable).toBe(false);
    expect(r.reason).toBe("needs_site");
    expect(r.connect).toEqual([]);
  });

  it("agrees with channelsDue on every channel in the registry", () => {
    for (const hasSite of [true, false]) {
      for (const ch of CHANNELS) {
        const states: ChannelState[] = [
          { channel_slug: ch.slug, last_run_at: null, priority: 100 },
        ];
        const due = channelsDue(states, NONE, Date.now(), CHANNELS.length, hasSite);
        const readiness = channelReadiness(ch.slug, NONE, hasSite);
        if (due.includes(ch.slug)) {
          expect(
            readiness.runnable,
            `${ch.slug} is scheduled by channelsDue but reported not runnable`,
          ).toBe(true);
        }
      }
    }
  });
});
