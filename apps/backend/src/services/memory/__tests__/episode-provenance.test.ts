import { describe, it, expect } from "vitest";
import { deriveEpisodeProvenance } from "../episode-provenance";
import { buildEpisodeNote, type EpisodeSignalRow } from "../build-episode-note";

const tc = (over: Record<string, unknown> = {}) => ({
  name: "slack__post_message",
  input_preview: "x",
  output_preview: "y",
  ms: 10,
  status: "ok",
  ...over,
});

describe("deriveEpisodeProvenance", () => {
  it("returns null on absent/empty/garbage input (episode stays pre-P0.1 shape)", () => {
    expect(deriveEpisodeProvenance(undefined)).toBeNull();
    expect(deriveEpisodeProvenance(null)).toBeNull();
    expect(deriveEpisodeProvenance([])).toBeNull();
    expect(deriveEpisodeProvenance("not-an-array")).toBeNull();
    expect(deriveEpisodeProvenance([null, 42, {}, { name: "  " }])).toBeNull();
  });

  it("dedupes connector prefixes from tool names", () => {
    const p = deriveEpisodeProvenance([
      tc({ name: "slack__post_message" }),
      tc({ name: "slack__list_channels" }),
      tc({ name: "stripe__list_charges" }),
      tc({ name: "web_search" }),
    ]);
    expect(p!.connectors_used).toEqual(["slack", "stripe", "web_search"]);
  });

  it("extracts the real connector from SDK-wrapped names (regression: prod collapsed all to 'mcp')", () => {
    const p = deriveEpisodeProvenance([
      tc({ name: "mcp__server__github__search_code" }),
      tc({ name: "mcp__server__meta_ads__pixel_health" }),
      tc({ name: "mcp__server__growth__read_experiment_ledger" }),
      tc({ name: "mcp__server__github__read_file" }),
      tc({ name: "mcp__operator_db__query" }),
      tc({ name: "slack__post_message" }),
      tc({ name: "ToolSearch" }),
    ]);
    expect(p!.connectors_used).toEqual([
      "ToolSearch",
      "github",
      "growth",
      "meta_ads",
      "operator_db",
      "slack",
    ]);
    expect(p!.connectors_used).not.toContain("mcp");
    expect(p!.connectors_used).not.toContain("server");
  });

  it("records ok calls WITH returned ids as candidate_sources_checked (ids capped at 5)", () => {
    const ids = ["id-01", "id-02", "id-03", "id-04", "id-05", "id-06", "id-07"];
    const p = deriveEpisodeProvenance([
      tc({ name: "memory__search", returned_ids: ids }),
      tc({ name: "slack__post_message" }),
    ]);
    expect(p!.candidate_sources_checked).toEqual([
      { tool: "memory__search", returned_ids: ["id-01", "id-02", "id-03", "id-04", "id-05"], returned_count: 7 },
    ]);
  });

  it("drops non-opaque-id garbage from returned_ids (backfill jsonb defense)", () => {
    const p = deriveEpisodeProvenance([
      tc({
        name: "memory__search",
        returned_ids: [
          "6ef4bd6d-1111-2222-3333-444455556666",
          "cus_ABC123",
          "ravi@upcar.ai",
          "John Smith",
          "ab",
          123,
        ],
      }),
    ]);
    expect(p!.candidate_sources_checked).toEqual([
      {
        tool: "memory__search",
        returned_ids: ["6ef4bd6d-1111-2222-3333-444455556666", "cus_ABC123"],
        returned_count: 2,
      },
    ]);
  });

  it("records tool_error/throw calls as candidate_dead_ends with the short code only", () => {
    const p = deriveEpisodeProvenance([
      tc({ name: "web_fetch", status: "tool_error", code: "http_403" }),
      tc({ name: "stripe__charge", status: "throw" }),
    ]);
    expect(p!.candidate_dead_ends).toEqual([
      { tool: "web_fetch", code: "http_403" },
      { tool: "stripe__charge", code: "throw" },
    ]);
  });

  it("caps every list at 20 entries (episode is a summary, not a trace)", () => {
    const calls = Array.from({ length: 30 }, (_, i) =>
      tc({ name: `conn${i}__op`, status: "tool_error", code: "e" }),
    );
    const p = deriveEpisodeProvenance(calls);
    expect(p!.connectors_used.length).toBeLessThanOrEqual(20);
    expect(p!.candidate_dead_ends.length).toBe(20);
  });

  it("never carries preview text (C14: names/codes/ids only)", () => {
    const p = deriveEpisodeProvenance([
      tc({ input_preview: "SECRET-IN", output_preview: "SECRET-OUT", returned_ids: ["id1"] }),
    ]);
    expect(JSON.stringify(p)).not.toContain("SECRET-IN");
    expect(JSON.stringify(p)).not.toContain("SECRET-OUT");
  });
});

describe("buildEpisodeNote provenance rendering", () => {
  const base: EpisodeSignalRow = {
    agent_slug: "engineer",
    agent_run_id: "run-9",
    outcome: "accepted",
    trust_tier: 2,
    redacted_trajectory: {
      question: "Fix the flaky deploy?",
      output_text: "Pinned the runner version.",
      connectors_used: ["github", "slack"],
      candidate_sources_checked: [{ tool: "github__list_runs", returned_ids: ["run-0001"], returned_count: 3 }],
      candidate_dead_ends: [{ tool: "web_fetch", code: "http_403" }],
    },
  };

  it("renders the how-the-work-went block from provenance fields", () => {
    const n = buildEpisodeNote(base);
    expect(n!.body_markdown).toContain("How the work went:");
    expect(n!.body_markdown).toContain("Connectors used: github, slack");
    expect(n!.body_markdown).toContain("Evidence pulled: github__list_runs (3 ids)");
    expect(n!.body_markdown).toContain("Dead ends hit: web_fetch (http_403)");
    expect(n!.metadata.connectors_used).toEqual(["github", "slack"]);
    expect(n!.metadata.sources_checked_count).toBe(1);
    expect(n!.metadata.dead_end_count).toBe(1);
  });

  it("omits the block entirely on pre-P0.1 episodes (no provenance keys)", () => {
    const n = buildEpisodeNote({
      ...base,
      redacted_trajectory: { question: "q?", output_text: "a" },
    });
    expect(n!.body_markdown).not.toContain("How the work went:");
    expect(n!.metadata).not.toHaveProperty("connectors_used");
  });

  it("tolerates jsonb garbage in provenance fields (renders nothing, never throws)", () => {
    const n = buildEpisodeNote({
      ...base,
      redacted_trajectory: {
        question: "q?",
        connectors_used: "not-an-array",
        candidate_sources_checked: [{ nope: true }, null],
        candidate_dead_ends: 42,
      },
    });
    expect(n).not.toBeNull();
    expect(n!.body_markdown).not.toContain("How the work went:");
  });
});
