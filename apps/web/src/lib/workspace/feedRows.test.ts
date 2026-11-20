import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { actionsByChannel, orderedChannels, sortChannelsByAttention } from "./feedRows";

describe("actionsByChannel — the Feed shows growth work only", () => {
  it("drops a decision with no channel — that is Work, and Approvals owns it", () => {
    const m = actionsByChannel([
      { id: "eng", channel_slug: null },
      { id: "also-eng" },
      { id: "growth", channel_slug: "seo" },
    ]);
    expect([...m.keys()]).toEqual(["seo"]);
    expect(m.get("seo")?.map((d) => d.id)).toEqual(["growth"]);
  });

  it("drops a channel the registry does not know rather than inventing a row", () => {
    expect([...actionsByChannel([{ id: "x", channel_slug: "not_a_channel" }]).keys()]).toEqual([]);
  });

  it("keeps every action for a channel, not just the first", () => {
    const m = actionsByChannel([
      { id: "a", channel_slug: "meta_ads" },
      { id: "b", channel_slug: "meta_ads" },
    ]);
    expect(m.get("meta_ads")).toHaveLength(2);
  });
});

describe("orderedChannels — curated visible list", () => {
  it("returns the visible channels in display order", () => {
    expect(orderedChannels().map((c) => c.slug)).toEqual([
      "meta_ads",
      "google_ads",
      "tiktok_ads",
      "linkedin_ads",
      "youtube_ads",
      "reddit_ads",
      "x_ads",
      "chatgpt_ads",
      "seo",
      "geo",
      "linkedin_organic",
      "reddit_organic",
      "x_organic",
      "instagram_organic",
      "tiktok_organic",
      "pinterest_organic",
      "youtube_organic",
      "ugc",
      "generated_video",
      "email_marketing",
      "sms",
    ]);
  });

  it("names the creator channels by the job they do, from the registry", () => {
    const bySlug = new Map(orderedChannels().map((c) => [c.slug, c.name]));
    expect(bySlug.get("ugc")).toBe("UGC Videos");
    expect(bySlug.get("generated_video")).toBe("AI UGC Videos");
    expect(bySlug.has("influencer")).toBe(false);
  });

  it("names the geo channel so a founder looking for GEO finds it", () => {
    const geo = orderedChannels().find((c) => c.slug === "geo");
    expect(geo?.name).toBe("GEO");
  });

  it("every visible channel resolves from the real registry, not a UI stub", () => {
    const known = new Set<string>(CHANNELS.map((c) => c.slug));
    const missing = orderedChannels().map((c) => c.slug).filter((s) => !known.has(s));
    expect(missing, `visible but not in CHANNELS: ${missing.join(", ")}`).toEqual([]);
  });

  it("is deterministic", () => {
    expect(orderedChannels().map((c) => c.slug)).toEqual(orderedChannels().map((c) => c.slug));
  });
});

describe("sortChannelsByAttention — what needs you floats to the top", () => {
  const slugs = (m: ReturnType<typeof sortChannelsByAttention>) => m.map((c) => c.slug);
  const signals = (
    pending: Record<string, number> = {},
    state: Record<string, string> = {},
  ) => ({
    pendingBySlug: new Map(Object.entries(pending)),
    stateBySlug: new Map(Object.entries(state)),
  });

  it("keeps registry order when nothing needs attention", () => {
    expect(slugs(sortChannelsByAttention(orderedChannels(), signals()))).toEqual(
      orderedChannels().map((c) => c.slug),
    );
  });

  it("puts channels with work first", () => {
    const out = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ sms: 1, seo: 3, x_organic: 2 })),
    );
    expect(out.slice(0, 3)).toEqual(["seo", "x_organic", "sms"]);
  });

  it("does NOT rank by how much work, only whether there is any", () => {
    const out = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ google_ads: 1, sms: 5 })),
    );
    expect(out.slice(0, 2)).toEqual(["google_ads", "sms"]);
  });

  it("a count changing inside a tier moves nothing", () => {
    const before = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ seo: 5, sms: 1, google_ads: 3 })),
    );
    const after = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ seo: 1, sms: 4, google_ads: 2 })),
    );
    expect(after).toEqual(before);
  });

  it("still moves a channel when it crosses zero, which is the movement worth having", () => {
    const none = slugs(sortChannelsByAttention(orderedChannels(), signals({})));
    const some = slugs(sortChannelsByAttention(orderedChannels(), signals({ sms: 1 })));
    expect(none[0]).not.toBe("sms");
    expect(some[0]).toBe("sms");
  });

  it("ranks needs_review above running above the rest", () => {
    const out = slugs(
      sortChannelsByAttention(
        orderedChannels(),
        signals({}, { sms: "needs_review", ugc: "running", meta_ads: "delivered", seo: "idle" }),
      ),
    );
    expect(out.slice(0, 2)).toEqual(["sms", "ugc"]);
    expect(out[2]).toBe("meta_ads");
  });

  it("pending beats work_state, even a needs_review one", () => {
    const out = slugs(
      sortChannelsByAttention(
        orderedChannels(),
        signals({ sms: 1 }, { meta_ads: "needs_review" }),
      ),
    );
    expect(out.slice(0, 2)).toEqual(["sms", "meta_ads"]);
  });

  it("is stable within a tier — equal pending counts keep registry order", () => {
    const out = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ sms: 2, google_ads: 2, seo: 2 })),
    );
    expect(out.slice(0, 3)).toEqual(["google_ads", "seo", "sms"]);
  });

  it("ignores a zero pending count and an unknown state", () => {
    const out = slugs(
      sortChannelsByAttention(orderedChannels(), signals({ sms: 0 }, { ugc: "weird" })),
    );
    expect(out).toEqual(orderedChannels().map((c) => c.slug));
  });

  it("does not mutate its input", () => {
    const input = orderedChannels();
    const before = input.map((c) => c.slug);
    sortChannelsByAttention(input, signals({ sms: 1 }));
    expect(input.map((c) => c.slug)).toEqual(before);
  });
});
