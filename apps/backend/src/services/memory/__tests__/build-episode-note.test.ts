import { describe, it, expect } from "vitest";
import { buildEpisodeNote, type EpisodeSignalRow } from "../build-episode-note";

const base: EpisodeSignalRow = {
  agent_slug: "performance-marketer",
  agent_run_id: "run-123",
  outcome: "accepted",
  trust_tier: 2,
  redacted_trajectory: { question: "Should I pause the bay-area campaign?", output_text: "Pause it; CAC is 3x target." },
};

describe("buildEpisodeNote", () => {
  it("builds an accepted episode note keyed by run id", () => {
    const n = buildEpisodeNote(base);
    expect(n).not.toBeNull();
    expect(n!.source_ref).toBe("episode:run-123");
    expect(n!.title).toContain("performance-marketer");
    expect(n!.title).toContain("accepted");
    expect(n!.body_markdown).toContain("Should I pause the bay-area campaign?");
    expect(n!.body_markdown).toContain("This approach worked before.");
    expect(n!.metadata.outcome).toBe("accepted");
    expect(n!.metadata.agent_slug).toBe("performance-marketer");
  });

  it("marks a rejected episode with the do-not-repeat guard", () => {
    const n = buildEpisodeNote({ ...base, outcome: "rejected" });
    expect(n!.title).toContain("rejected");
    expect(n!.body_markdown).toContain("Do not repeat this approach");
  });

  it("returns null when there is no usable question (not recallable)", () => {
    expect(buildEpisodeNote({ ...base, redacted_trajectory: { output_text: "x" } })).toBeNull();
    expect(buildEpisodeNote({ ...base, redacted_trajectory: { question: "   " } })).toBeNull();
    expect(buildEpisodeNote({ ...base, redacted_trajectory: null })).toBeNull();
  });

  it("truncates a long proposed-output snippet", () => {
    const long = "x".repeat(1000);
    const n = buildEpisodeNote({ ...base, redacted_trajectory: { question: "q?", output_text: long } });
    expect(n!.body_markdown).toContain("…");
    expect(n!.body_markdown.length).toBeLessThan(long.length);
  });

  it("omits the proposed-output block when output_text is empty", () => {
    const n = buildEpisodeNote({ ...base, redacted_trajectory: { question: "q?" } });
    expect(n!.body_markdown).not.toContain("What I proposed:");
  });

  it("embeds the run id in the body so distinct episodes never content-hash-collide", () => {
    const a = buildEpisodeNote({ ...base, agent_run_id: "run-A" });
    const b = buildEpisodeNote({ ...base, agent_run_id: "run-B" });
    expect(a!.body_markdown).toContain("run-A");
    expect(b!.body_markdown).toContain("run-B");
    expect(a!.body_markdown).not.toEqual(b!.body_markdown);
    expect(a!.source_ref).not.toEqual(b!.source_ref);
  });
});
