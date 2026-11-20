
import { describe, it, expect } from "vitest";
import { CHANNELS, channelForBriefKind, getChannel } from "@zavi/shared";
import { loadChannelRecipe } from "@/services/channels/recipe";

const metaAds = getChannel("meta_ads")!;
const metaRecipe = loadChannelRecipe("meta_ads");
const ugcRecipe = loadChannelRecipe("ugc");

describe("meta_ads can turn a fatigue finding into a commissioned brief", () => {
  it("declares the brief writer its own recipe binds", () => {
    expect(metaAds.tools as readonly string[]).toContain("growth_propose_creative_brief");
  });

  it("binds it at both the steps the declaration exists for", () => {
    const binders = metaRecipe.meta.router
      .filter((s) => s.tools.includes("growth__propose_creative_brief"))
      .map((s) => s.id);
    expect(binders.sort()).toEqual(["deliverable", "launch_kit"]);
  });

  it("reads fatigue at AD level, because aggregates conceal a tired creative", () => {
    const step = metaRecipe.meta.router.find((s) => s.id === "creative_fatigue");
    expect(step?.when).toBe("connected");
    expect(step?.tools).toContain("meta_ads__list_ads");
  });

  it("the deliverable step can write the brief the fatigue finding owes", () => {
    const step = metaRecipe.meta.router.find((s) => s.id === "deliverable");
    expect(step?.when).toBe("always");
    expect(step?.tools).toContain("growth__propose_creative_brief");
  });

  it("tells the run to name the specific fatiguing ad in the brief", () => {
    expect(metaRecipe.body).toMatch(/growth__propose_creative_brief/);
    expect(metaRecipe.body).toMatch(/ad_id/);
  });
});

describe("ugc stays connector-free, and receives the brief instead of reading Meta", () => {
  it("declares no connector", () => {
    const ugc = getChannel("ugc")!;
    expect(ugc.connectors).toEqual([]);
    expect(ugc.readiness).toBe("live");
  });

  it("has no router step that reads a Meta ad account", () => {
    const metaBound = ugcRecipe.meta.router
      .flatMap((s) => s.tools)
      .filter((t) => /^meta_ads/.test(t));
    expect(metaBound).toEqual([]);
  });

  it("has no connected step at all, so nothing can promise account data", () => {
    expect(ugcRecipe.meta.router.filter((s) => s.when === "connected")).toEqual([]);
    expect(ugcRecipe.meta.inputs.connected).toEqual([]);
  });

  it("is where a creative brief lands, by brief_kind and not by authoring channel", () => {
    expect(channelForBriefKind("creative")?.slug).toBe("ugc");
  });

  it("exactly one open channel claims the creative brief_kind", () => {
    const claimants = (CHANNELS as readonly { slug: string; human?: { available: boolean; brief_kind: string } }[])
      .filter((c) => c.human?.available === true && c.human.brief_kind === "creative")
      .map((c) => c.slug);
    expect(claimants).toEqual(["ugc"]);
  });
});
