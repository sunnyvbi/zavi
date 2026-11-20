import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cosScrubAndAnnotate } from "../post-run";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const ctx = { tenant_id: "t1", runId: "r1" } as unknown as AgentContext;

function result(over: Partial<DispatcherResult>): DispatcherResult {
  return {
    tool_calls: [],
    parsed: null,
    output_text: "",
    parse_ok: false,
    resolved_tool_names: [],
    ...over,
  } as unknown as DispatcherResult;
}

const REVENUE_TOOL = "operator_db__query_recent_transactions";

describe("cosScrubAndAnnotate — digest revenue safety-net", () => {
  it("no revenue data → strips an ungrounded **Revenue:** metric line in output_text", () => {
    const r = result({
      tool_calls: [],
      output_text: "- **Revenue:** $100K/mo (est.)",
      parse_ok: false,
    });
    cosScrubAndAnnotate(ctx, r);
    expect(r.output_text).toContain("unavailable this run");
    expect(r.output_text).not.toContain("$100K");
  });

  it("no revenue data → scrubs ungrounded GMV inside a parsed digest tier2 metric", () => {
    const r = result({
      tool_calls: [],
      parse_ok: true,
      parsed: {
        tier2: [{ area: "growth", metrics: { gmv: "$100K/mo" } }],
        rendered_markdown: "x",
      } as unknown as DispatcherResult["parsed"],
    });
    cosScrubAndAnnotate(ctx, r);
    const p = r.parsed as { tier2: Array<{ metrics: Record<string, string> }> };
    expect(p.tier2[0].metrics.gmv).toBe("unavailable this run");
  });

  it("revenue tool returned rows → does NOT strip a grounded figure", () => {
    const r = result({
      tool_calls: [
        { name: REVENUE_TOOL, output_preview: '{"ok":true,"rows":[{"gmv_cents":1}]}', status: "ok" },
      ] as unknown as DispatcherResult["tool_calls"],
      output_text: "- **Revenue:** $94.2K/wk",
      parse_ok: false,
    });
    cosScrubAndAnnotate(ctx, r);
    expect(r.output_text).toContain("$94.2K");
  });

  it("wired connector + no data + parse_ok digest → appends the grounding-skip tier4 line + warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = result({
      tool_calls: [],
      parse_ok: true,
      resolved_tool_names: [REVENUE_TOOL],
      parsed: { tier1: [], tier2: [], tier3: [], tier4: [] } as unknown as DispatcherResult["parsed"],
    });
    cosScrubAndAnnotate(ctx, r);
    const p = r.parsed as { tier4: Array<{ category: string; summary: string }> };
    expect(
      p.tier4.some(
        (t) => t.category === "fleet-health" && t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped"))).toBe(true);
    warn.mockRestore();
  });

  it("CHAT PROSE prose_fallback (parse_ok=true, parsed={rendered_markdown,refused}) → no tier4 manufactured (codex P2)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = result({
      tool_calls: [],
      parse_ok: true,
      resolved_tool_names: [REVENUE_TOOL],
      parsed: {
        rendered_markdown: "Here's my read on the week.",
        refused: true,
      } as unknown as DispatcherResult["parsed"],
      output_text: "Here's my read on the week.",
    });
    expect(() => cosScrubAndAnnotate(ctx, r)).not.toThrow();
    expect((r.parsed as { tier4?: unknown }).tier4).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("CHAT PROSE (parse_ok=false, parsed=null) → no tier4 mutation, no throw (digest-shaped gate)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = result({
      tool_calls: [],
      parse_ok: false,
      parsed: null,
      resolved_tool_names: [REVENUE_TOOL],
      output_text: "Here's my read on the week.",
    });
    expect(() => cosScrubAndAnnotate(ctx, r)).not.toThrow();
    expect(r.parsed).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("chat mode-lock wiring (P1-2)", () => {
  const root = join(__dirname, "..", "..", "..");
  const gd = readFileSync(
    join(root, "services", "agents", "generic-dispatcher.ts"),
    "utf8",
  );
  const agentMd = readFileSync(join(__dirname, "..", "agent.md"), "utf8");

  it("generic-dispatcher gates the relabel + carrier on chat_thought_partner_mode", () => {
    expect(gd).toContain("chat_thought_partner_mode");
    expect(gd).toContain("background_fleet_activity_24h");
    expect(gd).toMatch(/THOUGHT-PARTNER chat turn/i);
  });

  it("chief-of-staff agent.md opts into the flag", () => {
    expect(agentMd).toMatch(/chat_thought_partner_mode:\s*true/);
  });
});

describe("cosChatPostProcess wiring (index.ts)", () => {
  const idx = readFileSync(join(__dirname, "..", "..", "index.ts"), "utf8");

  it("registers chief-of-staff in postProcessors", () => {
    expect(idx).toMatch(/"chief-of-staff":\s*cosChatPostProcess/);
  });

  it("applies the prose strip to BOTH output_text and parsed.rendered_markdown (codex P2)", () => {
    expect(idx).toContain("scrubUngroundedRevenueProse(result.output_text");
    expect(idx).toContain("scrubUngroundedRevenueProse(parsed.rendered_markdown");
  });
});
