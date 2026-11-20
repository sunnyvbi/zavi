import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { joinChannelStates } from "../state";

describe("joinChannelStates", () => {
  it("returns one entry per registry channel from zero rows", () => {
    const out = joinChannelStates([]);
    expect(out).toHaveLength(CHANNELS.length);
    expect(out.map((s) => s.channel.slug)).toEqual(CHANNELS.map((c) => c.slug));
  });

  it("includes a channel this tenant was never seeded for, at column defaults", () => {
    const out = joinChannelStates([{ channel_slug: "seo", priority: 1 }]);
    const ugc = out.find((s) => s.channel.slug === "ugc");
    expect(ugc).toBeDefined();
    expect(ugc!.seeded).toBe(false);
    expect(ugc!.work_state).toBe("idle");
    expect(ugc!.priority).toBe(100);
    expect(ugc!.last_run_at).toBeNull();
    expect(ugc!.last_probe_at).toBeNull();
  });

  it("reports seeded state as stored, and marks it seeded", () => {
    const out = joinChannelStates([
      {
        channel_slug: "seo",
        work_state: "delivered",
        priority: 2,
        last_run_at: "2026-09-04T18:42:10.374Z",
        last_probe_at: "2026-09-05T06:00:00.000Z",
      },
    ]);
    const seo = out.find((s) => s.channel.slug === "seo")!;
    expect(seo.seeded).toBe(true);
    expect(seo.work_state).toBe("delivered");
    expect(seo.priority).toBe(2);
    expect(seo.last_run_at).toBe("2026-09-04T18:42:10.374Z");
    expect(seo.last_probe_at).toBe("2026-09-05T06:00:00.000Z");
  });

  it("drops a row whose slug the registry no longer carries", () => {
    const out = joinChannelStates([
      { channel_slug: "winback", work_state: "delivered" },
      { channel_slug: "affiliate" },
      { channel_slug: "seo" },
    ]);
    expect(out.some((s) => s.channel.slug === "winback")).toBe(false);
    expect(out.some((s) => s.channel.slug === "affiliate")).toBe(false);
    expect(out).toHaveLength(CHANNELS.length);
  });

  it("an unseeded channel is indistinguishable from a seeded-but-untouched one, except for `seeded`", () => {
    const [seededRow] = joinChannelStates([{ channel_slug: "ugc" }]).filter(
      (s) => s.channel.slug === "ugc",
    );
    const [bare] = joinChannelStates([]).filter((s) => s.channel.slug === "ugc");
    const { seeded: a, ...seededRest } = seededRow;
    const { seeded: b, ...bareRest } = bare;
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(seededRest).toEqual(bareRest);
  });

  it("keeps registry order, so callers that do not sort still get a stable list", () => {
    const out = joinChannelStates([{ channel_slug: "sms", priority: 1 }]);
    expect(out.map((s) => s.channel.slug)).toEqual(CHANNELS.map((c) => c.slug));
  });
});
