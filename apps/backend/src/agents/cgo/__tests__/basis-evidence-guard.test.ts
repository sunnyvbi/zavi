
import { describe, expect, it } from "vitest";
import {
  TOOL_LABELS,
  gapsFromUnusedTools,
  guardBasisEvidence,
  observedTools,
  sourceLabel,
  type BasisEvidence,
} from "../strategy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ev = (
  kind: BasisEvidence["kind"],
  source: string,
  statement = "something the plan is going on",
): BasisEvidence => ({ kind, source, statement });

describe("guardBasisEvidence", () => {
  it("keeps a platform claim that cites a tool the run actually called", () => {
    const kept = guardBasisEvidence([ev("platform", "growth__read_ads_perf")], {
      tools: ["growth__read_ads_perf"],
    });
    expect(kept).toHaveLength(1);
    expect(kept[0].source).toBe("growth__read_ads_perf");
  });

  it("DROPS a platform claim citing a tool the run never called", () => {
    const kept = guardBasisEvidence([ev("platform", "growth__read_ads_perf")], {
      tools: ["growth__seo_audit"],
    });
    expect(kept).toHaveLength(0);
  });

  it("DROPS a platform claim when the run called no tools at all", () => {
    const kept = guardBasisEvidence([ev("platform", "growth__read_ads_perf")], {
      tools: [],
    });
    expect(kept).toHaveLength(0);
  });

  it("DROPS a model-authored gap, because gaps are code-generated", () => {
    const kept = guardBasisEvidence(
      [ev("gap", "", "You have no analytics connected")],
      { tools: ["growth__seo_audit"] },
    );
    expect(kept).toHaveLength(0);
  });

  it("strips the source off an inferred claim — a derivation is not a reading", () => {
    const kept = guardBasisEvidence(
      [
        ev("platform", "growth__read_ads_perf", "spend is concentrated"),
        ev("inferred", "growth__read_ads_perf", "Your buyers skew mobile"),
      ],
      { tools: ["growth__read_ads_perf"] },
    );
    expect(kept).toHaveLength(2);
    const inferredItem = kept.find((k) => k.kind === "inferred");
    expect(inferredItem?.source).toBe("");
    expect(inferredItem?.statement).toBe("Your buyers skew mobile");
  });

  it("keeps a founder claim citing a real company-fact key", () => {
    const kept = guardBasisEvidence([ev("founder", "who_we_serve")], {
      tools: [],
    });
    expect(kept).toHaveLength(1);
  });

  it("DROPS an inferred claim when the run read nothing at all", () => {
    const kept = guardBasisEvidence(
      [ev("inferred", "", "Ads performance showed CAC is falling")],
      { tools: [] },
    );
    expect(kept).toHaveLength(0);
  });

  it("DROPS an inferred claim when every reading was itself dropped", () => {
    const kept = guardBasisEvidence(
      [
        ev("platform", "growth__read_ads_perf", "dropped — never ran"),
        ev("inferred", "", "so CAC must be falling"),
      ],
      { tools: [] },
    );
    expect(kept).toHaveLength(0);
  });

  it("does NOT let a founder fact alone license an inference", () => {
    const kept = guardBasisEvidence(
      [ev("founder", "who_we_serve"), ev("inferred", "", "therefore X")],
      { tools: [] },
    );
    expect(kept.map((k) => k.kind)).toEqual(["founder"]);
  });

  it("keeps an inferred claim once a real reading survived", () => {
    const kept = guardBasisEvidence(
      [
        ev("platform", "growth__read_ads_perf", "spend is concentrated"),
        ev("inferred", "", "so activation is the binding constraint"),
      ],
      { tools: ["growth__read_ads_perf"] },
    );
    expect(kept).toHaveLength(2);
    expect(kept[1].source).toBe("");
  });

  it("DROPS a founder claim citing something that is not a company-fact key", () => {
    const kept = guardBasisEvidence([ev("founder", "your_crm_export")], {
      tools: [],
    });
    expect(kept).toHaveLength(0);
  });

  it("DROPS a founder claim that cites a tool name to smuggle itself through", () => {
    const kept = guardBasisEvidence([ev("founder", "growth__read_ads_perf")], {
      tools: ["growth__read_ads_perf"],
    });
    expect(kept).toHaveLength(0);
  });

  it("keeps the surviving items and drops only the bad ones", () => {
    const kept = guardBasisEvidence(
      [
        ev("platform", "growth__read_ads_perf", "kept — ran"),
        ev("platform", "growth__liquidity_gap", "dropped — did not run"),
        ev("founder", "markets", "kept — real fact key"),
        ev("gap", "", "dropped — model authored"),
      ],
      { tools: ["growth__read_ads_perf"] },
    );
    expect(kept.map((k) => k.statement)).toEqual([
      "kept — ran",
      "kept — real fact key",
    ]);
  });
});

describe("gapsFromUnusedTools", () => {
  it("never counts filing a business-controls card as evidence, so it cannot license an inference", () => {
    const kept = guardBasisEvidence(
      [
        { kind: "platform", source: "growth__propose_business_controls", statement: "Your target CAC is 40." },
        { kind: "inferred", source: "", statement: "So CAC is the constraint." },
      ],
      { tools: ["growth__propose_business_controls"] },
    );
    expect(kept).toEqual([]);
  });
  it("never lists the business-controls proposal tool as an unread gap", () => {
    const gaps = gapsFromUnusedTools(["growth__propose_business_controls", "growth__seo_audit"], { tools: [] });
    expect(gaps.map((g) => g.statement)).toEqual(["Site audit was not read for this plan."]);
  });
  it("names the read tools that did NOT run", () => {
    const gaps = gapsFromUnusedTools(
      ["growth__read_ads_perf", "growth__seo_audit"],
      { tools: ["growth__seo_audit"] },
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("gap");
    expect(gaps[0].statement).toContain("Ads performance");
  });

  it("produces no gaps when every read tool ran", () => {
    const gaps = gapsFromUnusedTools(["growth__seo_audit"], {
      tools: ["growth__seo_audit"],
    });
    expect(gaps).toHaveLength(0);
  });

  it("ignores non-growth tools — memory is not a growth data source", () => {
    const gaps = gapsFromUnusedTools(["memory__search"], { tools: [] });
    expect(gaps).toHaveLength(0);
  });
});

describe("sourceLabel", () => {
  it("turns tool and fact slugs into words a founder can read", () => {
    expect(sourceLabel("growth__read_ads_perf")).toBe("Ads performance");
    expect(sourceLabel("who_we_serve")).toBe("Who you serve");
  });

  it("returns empty for an unknown source rather than leaking the slug", () => {
    expect(sourceLabel("growth__some_new_tool")).toBe("");
    expect(sourceLabel("")).toBe("");
  });
});

describe("observedTools", () => {
  it("does NOT count a tool call that failed", () => {
    expect(
      observedTools([{ name: "growth__read_ads_perf", status: "tool_error" }]),
    ).toEqual([]);
    expect(
      observedTools([{ name: "growth__read_ads_perf", status: "throw" }]),
    ).toEqual([]);
  });

  it("counts a successful call", () => {
    expect(
      observedTools([{ name: "growth__read_ads_perf", status: "ok" }]),
    ).toEqual(["growth__read_ads_perf"]);
  });

  it("normalises the SDK's wrapped trace name to the prompt's bare name", () => {
    expect(
      observedTools([
        { name: "mcp__server__growth__read_ads_perf", status: "ok" },
      ]),
    ).toEqual(["growth__read_ads_perf"]);
    expect(
      observedTools([{ name: "mcp__growth__seo_audit", status: "ok" }]),
    ).toEqual(["growth__seo_audit"]);
  });

  it("leaves an already-bare legacy name alone", () => {
    expect(
      observedTools([{ name: "growth__seo_audit", status: "ok" }]),
    ).toEqual(["growth__seo_audit"]);
  });

  it("survives a missing or malformed trace list", () => {
    expect(observedTools(undefined)).toEqual([]);
    expect(observedTools([{ status: "ok" }])).toEqual([]);
  });
});

describe("TOOL_LABELS drift", () => {
  it("labels every growth__ tool the agent actually declares", () => {
    const md = readFileSync(join(__dirname, "../agent.md"), "utf8");
    const declared = [...md.matchAll(/^\s*-\s+(growth__[a-z_]+)\s*$/gim)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const tool of declared) {
      expect(Object.keys(TOOL_LABELS)).toContain(tool);
    }
  });
});
