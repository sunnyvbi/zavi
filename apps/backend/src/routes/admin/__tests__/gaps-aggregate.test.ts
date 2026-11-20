
import { describe, it, expect } from "vitest";
import { extractGapEpisodes, type GapSignalRow } from "../gaps";
import {
  aggregateGaps,
  normalizeQuestion,
  questionHash,
  type GapEpisode,
} from "@/services/memory/gap-aggregate";

function mkSignal(over: Partial<GapSignalRow> = {}): GapSignalRow {
  return {
    tenant_id: "t1",
    agent_slug: "cto",
    status: "failed",
    created_at: "2026-01-01T00:00:00Z",
    redacted_trajectory: { question: "how do I cancel a booking?" },
    ...over,
  };
}

describe("extractGapEpisodes", () => {
  it("empty input → no episodes", () => {
    expect(extractGapEpisodes([])).toEqual({ episodes: [], withQuestion: 0 });
  });

  it("pulls the question string into an episode", () => {
    const { episodes, withQuestion } = extractGapEpisodes([mkSignal()]);
    expect(withQuestion).toBe(1);
    expect(episodes).toEqual([
      {
        tenant_id: "t1",
        agent_slug: "cto",
        status: "failed",
        created_at: "2026-01-01T00:00:00Z",
        question: "how do I cancel a booking?",
      },
    ]);
  });

  it("drops rows with no usable question (null trajectory, missing/blank/non-string question)", () => {
    const rows: GapSignalRow[] = [
      mkSignal({ redacted_trajectory: null }),
      mkSignal({ redacted_trajectory: {} }),
      mkSignal({ redacted_trajectory: { question: "   " } }),
      mkSignal({ redacted_trajectory: { question: 42 } }),
    ];
    expect(extractGapEpisodes(rows)).toEqual({ episodes: [], withQuestion: 0 });
  });

  it("excludes trust_tier=3 rows (defense in depth vs the SQL filter)", () => {
    const rows: GapSignalRow[] = [
      mkSignal({ trust_tier: 3, redacted_trajectory: { question: "attacker probe" } }),
      mkSignal({ trust_tier: 1, redacted_trajectory: { question: "legit q" } }),
      mkSignal({ trust_tier: undefined, redacted_trajectory: { question: "no-tier q" } }),
    ];
    const { episodes, withQuestion } = extractGapEpisodes(rows);
    expect(withQuestion).toBe(2);
    expect(episodes.map((e) => e.question)).toEqual(["legit q", "no-tier q"]);
  });
});

describe("normalizeQuestion", () => {
  it("trims, lowercases, collapses internal whitespace", () => {
    expect(normalizeQuestion("  How   Do\tI\nCancel? ")).toBe("how do i cancel?");
  });
  it("caps at 500 chars", () => {
    expect(normalizeQuestion("a".repeat(800))).toHaveLength(500);
  });
});

describe("questionHash", () => {
  it("is stable for the same tenant + normalized question", () => {
    expect(questionHash("t1", "How DO i cancel?")).toBe(questionHash("t1", "how do i cancel?"));
  });
  it("differs across tenants for the same question (per-tenant dedup key)", () => {
    expect(questionHash("t1", "q")).not.toBe(questionHash("t2", "q"));
  });
  it("returns a 32-char hex string", () => {
    const h = questionHash("t1", "q");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("aggregateGaps", () => {
  function ep(over: Partial<GapEpisode> = {}): GapEpisode {
    return {
      tenant_id: "t1",
      agent_slug: "cto",
      status: "failed",
      created_at: "2026-01-01T00:00:00Z",
      question: "how do I cancel?",
      ...over,
    };
  }

  it("groups near-identical questions (case/whitespace) into one group", () => {
    const groups = aggregateGaps(
      [ep({ question: "How do I cancel?" }), ep({ question: "  how do I   cancel? " })],
      1,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it("respects minCount (drops groups below threshold)", () => {
    const groups = aggregateGaps(
      [
        ep({ question: "asked twice" }),
        ep({ question: "asked twice" }),
        ep({ question: "asked once" }),
      ],
      2,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].question).toBe("asked twice");
    expect(groups[0].count).toBe(2);
  });

  it("keeps distinct tenants in separate groups even for the same question", () => {
    const groups = aggregateGaps([ep({ tenant_id: "t1" }), ep({ tenant_id: "t2" })], 1);
    expect(groups).toHaveLength(2);
  });

  it("collects distinct agents + statuses and tracks last_seen", () => {
    const groups = aggregateGaps(
      [
        ep({ agent_slug: "cto", status: "failed", created_at: "2026-01-01T00:00:00Z" }),
        ep({ agent_slug: "ads", status: "parse_failed", created_at: "2026-01-05T00:00:00Z" }),
        ep({ agent_slug: "cto", status: "failed", created_at: "2026-01-03T00:00:00Z" }),
      ],
      1,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].agents.sort()).toEqual(["ads", "cto"]);
    expect(groups[0].statuses.sort()).toEqual(["failed", "parse_failed"]);
    expect(groups[0].last_seen).toBe("2026-01-05T00:00:00Z");
  });

  it("sorts groups by count descending", () => {
    const groups = aggregateGaps(
      [
        ep({ question: "rare" }),
        ep({ question: "common" }),
        ep({ question: "common" }),
        ep({ question: "common" }),
      ],
      1,
    );
    expect(groups.map((g) => g.question)).toEqual(["common", "rare"]);
    expect(groups[0].count).toBe(3);
  });

  it("skips blank-question episodes defensively", () => {
    expect(aggregateGaps([ep({ question: "   " })], 1)).toEqual([]);
  });
});
