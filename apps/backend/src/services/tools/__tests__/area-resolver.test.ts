import { describe, it, expect } from "vitest";
import {
  compressToolsToAreas,
  renderToolAreasForPrompt,
  type CompressResult,
} from "../area-resolver";
import type { ToolArea } from "../areas";

const FIXTURE: ToolArea[] = [
  {
    id: "slack_ops",
    name: "Slack",
    description: "Read and send across Slack.",
    tool_slugs: ["slack_list_channels", "slack_get_channel_history"],
  },
  {
    id: "memory_ops",
    name: "Brain memory",
    description: "Search and write memory notes.",
    tool_slugs: ["memory_search", "memory_write"],
  },
  {
    id: "empty_area",
    name: "Empty placeholder",
    description: "Reserved for future tools.",
    tool_slugs: [],
  },
];

describe("compressToolsToAreas", () => {
  it("all area-mapped tools → single area entry per area", () => {
    const r = compressToolsToAreas(
      ["slack_list_channels", "slack_get_channel_history"],
      FIXTURE,
    );
    expect(r.areas.length).toBe(1);
    expect(r.areas[0].id).toBe("slack_ops");
    expect(r.areas[0].tool_slugs).toEqual([
      "slack_get_channel_history",
      "slack_list_channels",
    ]);
    expect(r.unmatched).toEqual([]);
  });

  it("partial subset → area with filtered sub-slugs", () => {
    const r = compressToolsToAreas(["slack_list_channels"], FIXTURE);
    expect(r.areas[0].tool_slugs).toEqual(["slack_list_channels"]);
  });

  it("unmapped tool → falls through to unmatched", () => {
    const r = compressToolsToAreas(["bogus_tool"], FIXTURE);
    expect(r.areas).toEqual([]);
    expect(r.unmatched).toEqual(["bogus_tool"]);
  });

  it("mix of mapped + unmapped → both populated correctly", () => {
    const r = compressToolsToAreas(
      ["slack_list_channels", "memory_search", "unmapped_x", "unmapped_a"],
      FIXTURE,
    );
    expect(r.areas.length).toBe(2);
    expect(r.areas.map((a) => a.id)).toEqual(["slack_ops", "memory_ops"]);
    expect(r.unmatched).toEqual(["unmapped_a", "unmapped_x"]);
  });

  it("empty placeholder area → never emitted (no matching slugs)", () => {
    const r = compressToolsToAreas(["slack_list_channels"], FIXTURE);
    expect(r.areas.map((a) => a.id)).not.toContain("empty_area");
  });

  it("empty granted list → empty result", () => {
    const r = compressToolsToAreas([], FIXTURE);
    expect(r.areas).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it("deterministic across calls (no Set iteration leak)", () => {
    const a: CompressResult = compressToolsToAreas(
      ["slack_get_channel_history", "slack_list_channels", "memory_write", "memory_search"],
      FIXTURE,
    );
    const b: CompressResult = compressToolsToAreas(
      ["memory_write", "slack_list_channels", "memory_search", "slack_get_channel_history"],
      FIXTURE,
    );
    expect(a).toEqual(b);
  });

  it("granted slug already covered by another area is not double-emitted", () => {
    const dupFixture: ToolArea[] = [
      { id: "a", name: "A", description: "", tool_slugs: ["shared_tool"] },
      { id: "b", name: "B", description: "", tool_slugs: ["shared_tool"] },
    ];
    const r = compressToolsToAreas(["shared_tool"], dupFixture);
    expect(r.areas.length).toBe(2);
    expect(r.unmatched).toEqual([]);
  });
});

describe("renderToolAreasForPrompt", () => {
  const fb = (slug: string) => `- ${slug} — (per-tool fallback for ${slug})`;

  it("areas only → markdown list, one line per area", () => {
    const out = renderToolAreasForPrompt(
      [
        {
          id: "slack_ops",
          name: "Slack",
          description: "Read and send across Slack.",
          tool_slugs: ["slack_list_channels", "slack_get_channel_history"],
        },
      ],
      [],
      fb,
    );
    expect(out).toBe(
      "- **Slack** (dispatcher for: slack_list_channels, slack_get_channel_history) — Read and send across Slack.",
    );
  });

  it("unmatched only → 'Other tools:' section, no area lines", () => {
    const out = renderToolAreasForPrompt([], ["foo", "bar"], fb);
    expect(out).toBe(
      "Other tools:\n- foo — (per-tool fallback for foo)\n- bar — (per-tool fallback for bar)",
    );
  });

  it("both → area lines, blank separator, Other tools section", () => {
    const out = renderToolAreasForPrompt(
      [
        {
          id: "slack_ops",
          name: "Slack",
          description: "Read Slack.",
          tool_slugs: ["slack_list_channels"],
        },
      ],
      ["bogus"],
      fb,
    );
    expect(out).toBe(
      [
        "- **Slack** (dispatcher for: slack_list_channels) — Read Slack.",
        "",
        "Other tools:",
        "- bogus — (per-tool fallback for bogus)",
      ].join("\n"),
    );
  });

  it("empty + empty → empty string", () => {
    expect(renderToolAreasForPrompt([], [], fb)).toBe("");
  });
});
