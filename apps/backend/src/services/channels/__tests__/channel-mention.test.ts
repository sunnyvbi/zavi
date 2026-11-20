
import { describe, it, expect } from "vitest";
import { matchChannelMention, isChannelMention } from "@zavi/shared";

describe("matchChannelMention", () => {
  it("takes the slug", () => {
    const m = matchChannelMention("@meta_ads why is CPA up");
    expect(m?.agent_slug).toBe("meta_ads");
    expect(m?.rest).toBe("why is CPA up");
  });

  it("takes the display name with a space", () => {
    const m = matchChannelMention("@meta ads why is CPA up");
    expect(m?.agent_slug).toBe("meta_ads");
    expect(m?.rest).toBe("why is CPA up");
  });

  it("takes a stray space after the @", () => {
    expect(matchChannelMention("@ meta ads why is CPA up")?.agent_slug).toBe(
      "meta_ads",
    );
  });

  it("takes a hyphen and any casing", () => {
    expect(matchChannelMention("@Meta-Ads check spend")?.agent_slug).toBe(
      "meta_ads",
    );
  });

  it("takes a display name that shares no word with its slug", () => {
    expect(
      matchChannelMention("@email campaigns draft a winback")?.agent_slug,
    ).toBe("email_marketing");
  });

  it("prefers the LONGEST label", () => {
    expect(matchChannelMention("@google ads pause the losers")?.agent_slug).toBe(
      "google_ads",
    );
  });

  it("strips punctuation between the address and the ask", () => {
    expect(matchChannelMention("@seo: audit the pricing page")?.rest).toBe(
      "audit the pricing page",
    );
  });

  it("reports an address with no ask, leaving the caller to decide", () => {
    const m = matchChannelMention("@meta ads");
    expect(m?.agent_slug).toBe("meta_ads");
    expect(m?.rest).toBe("");
  });

  it("does not match a name no channel answers to", () => {
    expect(matchChannelMention("@engineer fix the login bug")).toBeNull();
    expect(matchChannelMention("@metaads why is CPA up")).toBeNull();
    expect(matchChannelMention("@performance-marketer check spend")).toBeNull();
  });

  it("does not match mid-sentence", () => {
    expect(isChannelMention("compare @meta_ads to google")).toBe(false);
  });

  it("does not match a label that runs into a longer word", () => {
    expect(matchChannelMention("@seoul trip notes")).toBeNull();
  });

  it("ignores empty input", () => {
    expect(matchChannelMention("")).toBeNull();
    expect(matchChannelMention("@")).toBeNull();
  });
});
