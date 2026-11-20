
import { describe, it, expect } from "vitest";
import { loadChannelRecipe } from "@/services/channels/recipe";
import {
  applicableRouterSteps,
  buildChannelSkillBlock,
  readChannelSkill,
  MAX_CHANNEL_SKILL_BYTES,
} from "@/services/agents/channel-skills";
import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const recipe = loadChannelRecipe("ugc");
const steps = recipe.meta.router;

describe("ugc — what the run projects with NO connector (the normal case)", () => {
  const applicable = applicableRouterSteps(steps, false);
  const ids = applicable.map((s) => s.id);

  it("has no fatigue step to drop, and keeps the angle step", () => {
    expect(steps.map((s) => s.id)).not.toContain("fatigue_read");
    expect(ids).toContain("angle_from_public");
  });

  it("declares no step that reads a Meta ad account", () => {
    const metaTools = steps.flatMap((s) => s.tools.filter((t) => /^meta_ads/.test(t)));
    expect(metaTools).toEqual([]);
  });

  it("keeps every always-step, in recipe order", () => {
    expect(ids).toEqual([
      "demoability",
      "run_surface_and_rights",
      "reference_assets",
      "angle_from_public",
      "prioritise",
      "brief_and_candidates",
      "founder_cards",
    ]);
  });

  it("injects all four playbooks and loses none", () => {
    const block = buildChannelSkillBlock("ugc", applicable);
    expect(block.missing).toEqual([]);
    expect(block.skills).toEqual(["diagnose", "rank", "artifact", "founder_cards"]);
    expect(block.block).not.toBe("");
  });

  it("injects no body that the clamp truncated", () => {
    const block = buildChannelSkillBlock("ugc", applicable);
    for (const name of block.skills) {
      const loaded = readChannelSkill("ugc", name);
      expect(loaded, name).not.toBeNull();
      const bytes = Buffer.byteLength(loaded ?? "", "utf-8");
      expect({ name, truncated: bytes >= MAX_CHANNEL_SKILL_BYTES }).toEqual({
        name,
        truncated: false,
      });
      const onDisk = matter(
        readFileSync(
          path.join(process.cwd(), "src", "agents", "ugc", "skills", `${name}.md`),
          "utf-8",
        ),
      ).content.trim();
      expect(loaded, name).toBe(onDisk);
    }
  });
});

describe("ugc — the router encodes no connected branch at all", () => {
  it("projects the same run whether or not a connector is claimed", () => {
    const withConn = applicableRouterSteps(steps, true).map((s) => s.id);
    const without = applicableRouterSteps(steps, false).map((s) => s.id);
    expect(withConn).toEqual(without);
  });

  it("has no `connected` step, so nothing here can promise account data", () => {
    expect(steps.filter((s) => s.when === "connected").map((s) => s.id)).toEqual([]);
  });
});

describe("ugc — the artifact step can actually produce its artifact", () => {
  it("binds the brief writer, the shortlist and the renderer", () => {
    const artifact = steps.find((s) => s.id === "brief_and_candidates");
    expect(artifact?.skill).toBe("artifact");
    for (const t of [
      "growth_propose_creative_brief",
      "growth_search_human_members",
      "report_render_pdf",
    ]) {
      expect(artifact?.tools).toContain(t);
    }
  });

  it("renders the artifact the recipe frontmatter promises", () => {
    expect(recipe.meta.artifact).toEqual({ tool: "report_render_pdf", kind: "creator_brief" });
  });

  it("declares no connected inputs, because this channel measures nothing", () => {
    expect(recipe.meta.inputs.connected).toEqual([]);
  });
});
