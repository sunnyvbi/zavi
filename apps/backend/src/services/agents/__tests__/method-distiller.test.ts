import { describe, it, expect } from "vitest";
import {
  rankRunsByAtomScore,
  proposeMethodBlock,
  proposeMethodBlocks,
  renderProposalReport,
  type DistillerRun,
} from "@/services/agents/eval/method-distiller";

function tool(name: string, output_preview: string) {
  return {
    name,
    input_preview: "",
    output_preview,
    ms: 1,
    status: "ok" as const,
  };
}

function groundedRun(
  run_id: string,
  agent_slug: string,
  tenant_id = "tenant-a",
): DistillerRun {
  return {
    run_id,
    tenant_id,
    agent_slug,
    output_text:
      "Pulled the report. Spend is $1,200 and conversions are 1,204. Reallocating to the top adset.",
    tool_calls: [
      tool("meta_ads__report", '{"spend":1200,"conversions":1204}'),
    ],
    created_at: "2026-06-06T10:00:00Z",
  };
}

function ungroundedRun(run_id: string, agent_slug: string): DistillerRun {
  return {
    run_id,
    tenant_id: "tenant-a",
    agent_slug,
    output_text: "The cap is $999 and ROAS is up 47%, trust me.",
    tool_calls: [],
    created_at: "2026-06-05T10:00:00Z",
  };
}

describe("rankRunsByAtomScore", () => {
  it("ranks the better-grounded run first", () => {
    const ranked = rankRunsByAtomScore([
      ungroundedRun("bad", "operator"),
      groundedRun("good", "operator"),
    ]);
    expect(ranked[0].run.run_id).toBe("good");
    expect(ranked[0].score.grade).toBeGreaterThan(ranked[1].score.grade);
  });
});

describe("proposeMethodBlock — method-only + contamination gate", () => {
  it("ACCEPTS a clean method block distilled from grounded best runs", () => {
    const p = proposeMethodBlock({
      agentSlug: "operator",
      runs: [groundedRun("r1", "operator"), groundedRun("r2", "operator")],
    });
    expect(p.accepted).toBe(true);
    expect(p.scan.clean).toBe(true);
    expect(p.patterns.length).toBeGreaterThan(0);
    expect(p.block).toContain("## Method (distilled)");
    expect(p.block).not.toMatch(/\$\d/);
  });

  it("the distilled block itself never leaks a tenant fact (scanner-clean)", () => {
    const p = proposeMethodBlock({
      agentSlug: "performance-marketer",
      runs: [
        groundedRun("r1", "performance-marketer"),
        groundedRun("r2", "performance-marketer"),
      ],
      tenantTokens: ["UpcarAI", "73db45ff-457e-4541-bc8f-bdb625390204"],
    });
    expect(p.scan.clean).toBe(true);
    expect(p.accepted).toBe(true);
  });

  it("rejects when no method pattern is detectable", () => {
    const emptyRun: DistillerRun = {
      run_id: "e1",
      tenant_id: "t",
      agent_slug: "pm",
      output_text: "ok",
      tool_calls: [],
    };
    const p = proposeMethodBlock({ agentSlug: "pm", runs: [emptyRun] });
    expect(p.accepted).toBe(false);
    expect(p.rejectedReason).toMatch(/no method pattern/);
  });

  it("preserves growth-lead's two-mode contract in the proposed block", () => {
    const p = proposeMethodBlock({
      agentSlug: "growth-lead",
      runs: [groundedRun("g1", "growth-lead"), groundedRun("g2", "growth-lead")],
    });
    expect(p.accepted).toBe(true);
    expect(p.block).toMatch(/two modes/i);
    expect(p.block).toMatch(/PROSE/);
    expect(p.block).toMatch(/STRUCTURED/);
    expect(p.block).not.toMatch(/always emit (structured|prose)/i);
  });
});

describe("proposeMethodBlocks — fleet + per-tenant token union", () => {
  it("groups by agent and proposes one block per agent", () => {
    const proposals = proposeMethodBlocks({
      runs: [
        groundedRun("a1", "operator"),
        groundedRun("a2", "operator"),
        groundedRun("b1", "pm", "tenant-b"),
      ],
    });
    const slugs = proposals.map((p) => p.agentSlug).sort();
    expect(slugs).toEqual(["operator", "pm"]);
  });

  it("rejects a block when ANY contributing tenant's identity token leaks", () => {
    const p = proposeMethodBlock({
      agentSlug: "operator",
      runs: [groundedRun("r1", "operator")],
      tenantTokens: ["Ground"],
    });
    expect(p.accepted).toBe(false);
    expect(p.rejectedReason).toMatch(/contamination/);
  });
});

describe("renderProposalReport", () => {
  it("emits accepted + rejected sections and never claims an agent.md write", () => {
    const proposals = proposeMethodBlocks({
      runs: [groundedRun("a1", "operator"), groundedRun("a2", "operator")],
    });
    const md = renderProposalReport(proposals);
    expect(md).toMatch(/PROPOSED/);
    expect(md).toMatch(/human review before any agent\.md write/i);
    expect(md).toMatch(/## Accepted/);
    expect(md).toMatch(/## Rejected/);
  });
});
