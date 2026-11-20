
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/workspace/Markdown", () => ({
  Markdown: ({ source }: { source: string }) =>
    React.createElement("span", { "data-md": true }, source),
}));

import { PmEnvelopeRenderer, type PmEnvelope } from "../PmEnvelopeRenderer";

function render(envelope: PmEnvelope): string {
  return renderToStaticMarkup(
    React.createElement(PmEnvelopeRenderer, { envelope }),
  );
}

describe("PmEnvelopeRenderer — actionable", () => {
  const ACTIONABLE: PmEnvelope = {
    status: "actionable",
    backlog: [
      {
        item_id: "i1",
        theme: "checkout funnel regression",
        problem: "conversion dropped",
        proposed_fix: "fix payment step",
        rice_score: 12.3,
        impact: "high",
        effort: "medium",
      },
      {
        item_id: "i2",
        theme: "search latency",
        problem: "slow queries",
        proposed_fix: "add cache",
        rice_score: 4.5,
        impact: "medium",
        effort: "low",
      },
    ],
    dispatched_actions: [{ item_id: "i1", task_description: "Fix the checkout payment step" }],
    recommended_actions_not_dispatched: [
      { item_id: "i2", description: "Cache search results", target_team: "product", urgency: "this-week" },
    ],
  };

  it("renders a table with the heading and rice numbers", () => {
    const html = render(ACTIONABLE);
    expect(html).toContain("RICE-ranked backlog");
    expect(html).toContain("<table");
    expect(html).toContain("12.3");
    expect(html).toContain("4.5");
    expect(html).toContain("checkout funnel regression");
    expect(html).toContain("search latency");
  });

  it("renders dispatched + recommended action lists", () => {
    const html = render(ACTIONABLE);
    expect(html).toContain("Dispatched to engineer");
    expect(html).toContain("Fix the checkout payment step");
    expect(html).toContain("Recommended (not dispatched)");
    expect(html).toContain("Cache search results");
  });

  it("renders null when actionable but backlog is empty", () => {
    expect(render({ status: "actionable", backlog: [] })).toBe("");
  });
});

describe("PmEnvelopeRenderer — strategy_memo", () => {
  const MEMO: PmEnvelope = {
    status: "strategy_memo",
    strategy: {
      premise_check: "premise holds",
      reframe_options: [
        { title: "Go broad", rationale: "more TAM", metrics: ["TAM"], rank: 2 },
        { title: "Narrow the wedge", rationale: "focus on one ICP", metrics: ["activation", "retention"], rank: 1 },
      ],
      research_findings: [{ summary: "competitors lack provenance", source: "desk research" }],
    },
  };

  it("renders ranked options sorted by rank", () => {
    const html = render(MEMO);
    expect(html).toContain("Options (ranked)");
    expect(html).toContain("Narrow the wedge");
    expect(html).toContain("Go broad");
    expect(html.indexOf("Narrow the wedge")).toBeLessThan(html.indexOf("Go broad"));
    expect(html).toContain("activation");
    expect(html).toContain("retention");
  });

  it("renders premise check and research findings", () => {
    const html = render(MEMO);
    expect(html).toContain("Premise check");
    expect(html).toContain("premise holds");
    expect(html).toContain("Research findings");
    expect(html).toContain("competitors lack provenance");
    expect(html).toContain("desk research");
  });
});

describe("PmEnvelopeRenderer — skip statuses render null", () => {
  it("no_signal renders null", () => {
    expect(render({ status: "no_signal", rendered_markdown: "## No actionable signal" })).toBe("");
  });
  it("insufficient_data renders null", () => {
    expect(render({ status: "insufficient_data" })).toBe("");
  });
  it("undefined status renders null", () => {
    expect(render({})).toBe("");
  });
});
