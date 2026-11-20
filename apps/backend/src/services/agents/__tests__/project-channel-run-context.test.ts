import { describe, it, expect } from "vitest";
import { projectChannelRunContext } from "@/services/agents/generic-dispatcher";

const runs = [
  { agent_slug: "tiktok_organic", status: "success", output_text: "sibling A" },
  { agent_slug: "seo", status: "success", output_text: "own 1" },
  { agent_slug: "geo", status: "success", output_text: "sibling B" },
  { agent_slug: "seo", status: "success", output_text: "own 2" },
];

describe("projectChannelRunContext", () => {
  it("keeps only this channel's prior runs, in order", () => {
    const out = projectChannelRunContext(runs, {}, "seo");
    expect(out.recentRuns.map((r) => (r as { output_text: string }).output_text)).toEqual([
      "own 1",
      "own 2",
    ]);
  });

  it("lifts recipe_body out of the payload and leaves every other key", () => {
    const payload = { recipe_body: "## Rule\n\nDo X.", router: [{ id: "a" }], channel_slug: "seo" };
    const out = projectChannelRunContext(runs, payload, "seo");
    expect(out.recipeMarkdown).toBe("## Rule\n\nDo X.");
    expect(out.payload).toEqual({ router: [{ id: "a" }], channel_slug: "seo" });
    expect(payload.recipe_body).toBe("## Rule\n\nDo X.");
  });

  it("leaves the payload alone when there is no recipe body", () => {
    const payload = { router: [] };
    expect(projectChannelRunContext([], payload, "seo")).toEqual({
      recentRuns: [],
      payload,
      recipeMarkdown: null,
    });
    expect(projectChannelRunContext([], { recipe_body: "" }, "seo").recipeMarkdown).toBeNull();
    expect(projectChannelRunContext([], null, "seo").payload).toBeNull();
  });
});
