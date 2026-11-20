
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: vi.fn(),
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(),
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { writeNote } from "@/services/memory";
import { chiefOfStaffDispatcher } from "../dispatcher";
import { digestSchema } from "../output-schema";

const runGenericMock = runGeneric as ReturnType<typeof vi.fn>;
const visibleMock = getVisibleAgentSlugs as ReturnType<typeof vi.fn>;
const writeNoteMock = writeNote as ReturnType<typeof vi.fn>;

function makeCtx(emitDecision: ReturnType<typeof vi.fn>) {
  return {
    tenant_id: "t1",
    runId: "run-1",
    agent: { slug: "chief-of-staff" },
    emitDecision,
  } as never;
}

function envelope(
  parsed: Record<string, unknown>,
  opts: {
    tool_calls?: unknown[];
    resolved_tool_names?: string[];
    output_text?: string;
  } = {},
) {
  return {
    parse_ok: true,
    parsed: {
      tier1: [],
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "x",
      ...parsed,
    },
    output_text: opts.output_text ?? "x",
    tool_calls: opts.tool_calls ?? [],
    resolved_tool_names: opts.resolved_tool_names,
  };
}

const REV_TOOL = "operator_db__query_recent_transactions";

beforeEach(() => {
  vi.clearAllMocks();
  visibleMock.mockResolvedValue(
    new Set(["dispute-response", "support-lead", "performance-marketer", "qa", "pm"]),
  );
  writeNoteMock.mockResolvedValue("note-1");
});

describe("judgment harness — grounding (1.2 + gmv-guard)", () => {
  it("wired + revenue tool returned real data → metric UNCHANGED, no warn, no auto fleet-health line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      envelope(
        {
          tier2: [{ area: "liquidity", summary: "s", metrics: { gmv: "$94.2k/wk" } }],
        },
        {
          resolved_tool_names: [REV_TOOL, "memory__search"],
          tool_calls: [
            {
              name: REV_TOOL,
              output_preview: '{"ok":true,"rows":[{"gmv_cents":9420000}]}',
              status: "ok",
            },
          ],
        },
      ),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier2: Array<{ metrics?: Record<string, unknown> }>;
      tier4: Array<{ category: string; summary: string }>;
    };
    expect(parsed.tier2[0].metrics?.gmv).toBe("$94.2k/wk");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped")),
    ).toBe(false);
    expect(
      parsed.tier4.some((t) =>
        t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(false);
    warn.mockRestore();
  });

  it("wired + NO revenue data → metric scrubbed, grounding_skipped warn, Tier-4 fleet-health line injected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      envelope(
        {
          tier2: [{ area: "liquidity", summary: "s", metrics: { gmv: "~$100K/mo" } }],
        },
        {
          resolved_tool_names: [REV_TOOL],
          tool_calls: [
            { name: "memory__search", output_preview: '{"ok":true}', status: "ok" },
            {
              name: "operator_db__catalog",
              output_preview: '{"ready":false}',
              status: "ok",
            },
          ],
        },
      ),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier2: Array<{ metrics?: Record<string, unknown> }>;
      tier4: Array<{ category: string; summary: string }>;
    };
    expect(parsed.tier2[0].metrics?.gmv).toBe("unavailable this run");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped")),
    ).toBe(true);
    expect(
      parsed.tier4.some(
        (t) =>
          t.category === "fleet-health" &&
          t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("NOT wired → ungrounded $ still scrubbed, but NO grounding_skipped warn and NO fleet-health line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      envelope(
        {
          tier2: [{ area: "liquidity", summary: "s", metrics: { gmv: "~$100K/mo" } }],
        },
        { resolved_tool_names: [], tool_calls: [] },
      ),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier2: Array<{ metrics?: Record<string, unknown> }>;
      tier4: Array<{ category: string; summary: string }>;
    };
    expect(parsed.tier2[0].metrics?.gmv).toBe("unavailable this run");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped")),
    ).toBe(false);
    expect(
      parsed.tier4.some((t) =>
        t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(false);
    warn.mockRestore();
  });

  it("does not duplicate the fleet-health line if one already exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      envelope(
        {
          tier4: [
            {
              category: "fleet-health",
              summary:
                "Ran without pulling live numbers — operator_db/stripe were wired but no revenue read happened this run; figures may be stale. Pull recommended.",
            },
          ],
        },
        { resolved_tool_names: [REV_TOOL], tool_calls: [] },
      ),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier4: Array<{ category: string; summary: string }>;
    };
    const matches = parsed.tier4.filter((t) =>
      t.summary.startsWith("Ran without pulling live numbers"),
    );
    expect(matches.length).toBe(1);
    warn.mockRestore();
  });
});

describe("judgment harness — calibration (contract)", () => {
  it("clear T1 fire: schema valid, stays tier1, promotion_reason=rar, grounded impact preserved", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    const digest = {
      tier1: [
        {
          title: "Dispute spike",
          summary: "s",
          evidence: ["du_1A2B"],
          promotion_reason: "rar",
          estimated_impact_usd: 4200,
        },
      ],
    };
    expect(digestSchema.safeParse({ ...envelope(digest).parsed }).success).toBe(true);
    runGenericMock.mockResolvedValue(
      envelope(digest, {
        resolved_tool_names: [REV_TOOL],
        tool_calls: [
          {
            name: REV_TOOL,
            output_preview: '{"ok":true,"rows":[{"x":1}]}',
            status: "ok",
          },
        ],
      }),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier1: Array<{ promotion_reason?: string; estimated_impact_usd?: number }>;
    };
    expect(parsed.tier1.length).toBe(1);
    expect(parsed.tier1[0].promotion_reason).toBe("rar");
    expect(parsed.tier1[0].estimated_impact_usd).toBe(4200);
  });

  it("borderline below-threshold leak lives in tier3 with why_below_t1, tier1 empty (contract)", () => {
    const parsed = digestSchema.safeParse({
      tier1: [],
      tier2: [],
      tier3: [
        {
          title: "$150/wk leak",
          evidence: ["run_9"],
          why_below_t1: "under $200 RaR threshold",
        },
      ],
      tier4: [],
      rendered_markdown: "x",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tier1.length).toBe(0);
      expect(parsed.data.tier3[0].why_below_t1).toContain("threshold");
    }
  });
});

describe("judgment harness — continuity (contract)", () => {
  it("resolved prior fire appears as a tier4 ack line, NOT in tier1", () => {
    const parsed = digestSchema.safeParse({
      tier1: [],
      tier2: [],
      tier3: [],
      tier4: [
        { category: "resolved", summary: "Dispute spike — addressed yesterday, closed." },
      ],
      rendered_markdown: "x",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tier1.some((t) => t.title.includes("Dispute spike"))).toBe(
        false,
      );
      expect(
        parsed.data.tier4.some((t) => t.summary.includes("Dispute spike")),
      ).toBe(true);
    }
  });

  it("unacted prior fire is re-raised in tier1 with aged text in summary", () => {
    const parsed = digestSchema.safeParse({
      tier1: [
        {
          title: "Dispute spike",
          summary: "Re-raised — day 3, no run on the prior dispatch.",
          evidence: ["du_1A2B"],
          promotion_reason: "rar",
        },
      ],
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "x",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tier1[0].summary).toContain("day 3");
    }
  });

  it("a >7d missed accountability commitment surfaces as a tier1/tier3 line (contract)", () => {
    const parsed = digestSchema.safeParse({
      tier1: [],
      tier2: [],
      tier3: [
        {
          title:
            "performance-marketer rebalance — committed Mon, still no run, 8 days open",
          evidence: ["decision_77"],
          why_below_t1: "no direct RaR but a stale commitment",
        },
      ],
      tier4: [],
      rendered_markdown: "x",
      accountability: [
        { agent_slug: "performance-marketer", committed: "Rebalance Meta", status: "missed" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tier3[0].title).toContain("8 days open");
    }
  });
});

describe("judgment harness — calm day (1.4)", () => {
  it("quiet fixture: tier1 empty → dispatcher emits ZERO decisions, digest still returns", async () => {
    const emit = vi.fn();
    runGenericMock.mockResolvedValue(
      envelope({
        tier1: [],
        tier2: [{ area: "liquidity", summary: "Steady WoW.", metrics: {} }],
      }),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as { tier1: unknown[]; tier2: unknown[] };
    expect(parsed.tier1.length).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(parsed.tier2.length).toBe(1);
  });

  it("calm-day pass-through: dispatcher never ADDS a tier1 item", async () => {
    const emit = vi.fn();
    runGenericMock.mockResolvedValue(
      envelope({ tier1: [], tier2: [{ area: "ops", summary: "quiet", metrics: {} }] }),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as { tier1: unknown[] };
    expect(parsed.tier1.length).toBe(0);
  });
});
