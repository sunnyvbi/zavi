import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import {
  splitChannelMention,
  splitHandoffHeader,
  stripChannelMention,
} from "./channelMention";

describe("splitChannelMention", () => {
  it("splits the marker the composer writes into channel + body", () => {
    const r = splitChannelMention("@meta_ads how much did we spend last week?");
    expect(r.channel?.slug).toBe("meta_ads");
    expect(r.body).toBe("how much did we spend last week?");
  });

  it("leaves an unknown @word alone — it is ordinary text, not a marker", () => {
    const raw = "@someone can you look at this";
    const r = splitChannelMention(raw);
    expect(r.channel).toBeNull();
    expect(r.body).toBe(raw);
  });

  it("leaves a message with no marker untouched", () => {
    const raw = "how much did we spend last week?";
    expect(splitChannelMention(raw)).toEqual({ channel: null, body: raw });
  });

  it("does not treat a mid-sentence mention as a marker", () => {
    const raw = "ask @meta_ads about this";
    const r = splitChannelMention(raw);
    expect(r.channel).toBeNull();
    expect(r.body).toBe(raw);
  });

  it("handles a marker with an empty body", () => {
    const r = splitChannelMention("@meta_ads");
    expect(r.channel?.slug).toBe("meta_ads");
    expect(r.body).toBe("");
  });

  it("preserves newlines and indentation in the body", () => {
    const r = splitChannelMention("@seo line one\n  line two");
    expect(r.channel?.slug).toBe("seo");
    expect(r.body).toBe("line one\n  line two");
  });

  it("resolves every channel executor the composer can emit", () => {
    for (const c of CHANNELS) {
      const r = splitChannelMention(`@${c.executor} ask`);
      expect(r.channel, `executor ${c.executor}`).not.toBeNull();
      expect(r.channel?.executor).toBe(c.executor);
      expect(r.body).toBe("ask");
    }
  });

  it("gives every channel its own executor, so an @-mention names exactly one channel", () => {
    const executors = CHANNELS.map((c) => c.executor);
    expect(new Set(executors).size).toBe(executors.length);
    expect(splitChannelMention("@seo x").channel?.slug).toBe("seo");
    expect(splitChannelMention("@geo x").channel?.slug).toBe("geo");
  });
});

describe("stripChannelMention", () => {
  it("drops the marker so a thread title reads as the question", () => {
    expect(
      stripChannelMention("@meta_ads how much did we spend last week?"),
    ).toBe("how much did we spend last week?");
  });

  it("leaves an ordinary title untouched", () => {
    expect(stripChannelMention("Turo Competitor Market Research")).toBe(
      "Turo Competitor Market Research",
    );
  });

  it("returns empty for null", () => {
    expect(stripChannelMention(null)).toBe("");
  });
});

describe("splitHandoffHeader", () => {
  it("splits the specialist header off the reply body", () => {
    const r = splitHandoffHeader(
      "@meta_ads → handed off from @operator\n\n**Meta: $1,120 spend**",
    );
    expect(r.agentSlug).toBe("meta_ads");
    expect(r.fromSlug).toBe("operator");
    expect(r.channel?.slug).toBe("meta_ads");
    expect(r.body).toBe("**Meta: $1,120 spend**");
  });

  it("accepts the ascii arrow too", () => {
    const r = splitHandoffHeader("@seo -> handed off from @operator\nbody");
    expect(r.agentSlug).toBe("seo");
    expect(r.body).toBe("body");
  });

  it("keeps agentSlug for a specialist with no channel", () => {
    const r = splitHandoffHeader("@pm → handed off from @operator\n\nbody");
    expect(r.agentSlug).toBe("pm");
    expect(r.channel).toBeNull();
    expect(r.body).toBe("body");
  });

  it("leaves an ordinary reply untouched", () => {
    const raw = "Handed off — the Meta Ads specialist is pulling numbers.";
    const r = splitHandoffHeader(raw);
    expect(r.agentSlug).toBeNull();
    expect(r.body).toBe(raw);
  });
});
