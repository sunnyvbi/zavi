import { describe, it, expect } from "vitest";
import { matchAgentMention, matchChannelMention } from "../mention";

describe("matchAgentMention", () => {
  it("resolves Your CGO by name or slug, with the ask kept", () => {
    expect(matchAgentMention("@Your CGO what's holding my growth back?")).toEqual({
      agent_slug: "cgo",
      name: "Your CGO",
      rest: "what's holding my growth back?",
    });
    expect(matchAgentMention("@cgo where should I spend")?.agent_slug).toBe("cgo");
  });

  it("resolves the agents with their own page", () => {
    expect(matchAgentMention("@engineer fix the footer")?.agent_slug).toBe("engineer");
    expect(matchAgentMention("@Supply & Demand which cities")?.agent_slug).toBe("supply-demand-balancer");
    expect(matchAgentMention("@fundraising: list angels")?.rest).toBe("list angels");
  });

  it("does not match helpers without a page, prose mentions, or a longer word", () => {
    expect(matchAgentMention("@support-lead refund")).toBeNull();
    expect(matchAgentMention("ask @cgo later")).toBeNull();
    expect(matchAgentMention("@cgoal")).toBeNull();
  });

  it("does not steal a channel address", () => {
    expect(matchAgentMention("@meta ads why is CPA up")).toBeNull();
    expect(matchChannelMention("@cgo hi")).toBeNull();
  });
});
