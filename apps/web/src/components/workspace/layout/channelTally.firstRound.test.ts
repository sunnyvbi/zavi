import { describe, expect, it } from "vitest";
import { canExecuteChannel, canReadChannel, needYouTally } from "./channelTally";
import type { ChannelEntry } from "./ChannelsPage";

const entry = (slug: string, waiting: number, lock: ChannelEntry["lock"]): ChannelEntry =>
  ({ channel: { slug, name: slug, connectors: [] }, count: 0, waiting, subtitle: null, lock }) as unknown as ChannelEntry;

const shut: ChannelEntry["lock"] = { kind: "plan", label: "Starter plan", tier: "starter" };
const open: ChannelEntry["lock"] = { kind: "plan", label: "Starter plan", tier: "starter", open: true };

describe("needYouTally with a first-round-open channel", () => {
  it("counts its cards and its channel", () => {
    const tally = needYouTally([entry("seo", 3, open), entry("reddit_organic", 2, shut)]);
    expect(tally).toEqual({ items: 3, channels: 1, lockedOnly: false });
  });

  it("a workspace whose only work is behind a shut lock is still upgrade-to-start", () => {
    expect(needYouTally([entry("reddit_organic", 2, shut)])).toEqual({ items: 0, channels: 0, lockedOnly: true });
  });

  it("an unlocked channel counts as before", () => {
    expect(needYouTally([entry("seo", 4, null)])).toEqual({ items: 4, channels: 1, lockedOnly: false });
  });
});

describe("the two channel predicates", () => {
  it("read: no lock, or a plan lock that is open; never Coming soon", () => {
    expect(canReadChannel({ lock: null })).toBe(true);
    expect(canReadChannel({ lock: open })).toBe(true);
    expect(canReadChannel({ lock: shut })).toBe(false);
    expect(canReadChannel({ lock: { kind: "soon" } })).toBe(false);
  });

  it("execute: only with no lock at all", () => {
    expect(canExecuteChannel({ lock: null })).toBe(true);
    expect(canExecuteChannel({ lock: open })).toBe(false);
    expect(canExecuteChannel({ lock: shut })).toBe(false);
  });
});
