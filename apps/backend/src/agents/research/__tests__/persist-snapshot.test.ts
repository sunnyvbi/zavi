
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

let priorRows: Array<{ week_bucket: string; landscape: unknown }> = [];
let priorError: { message: string } | null = null;
const rpcMock = vi.fn(
  async (): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: "new-id",
    error: null,
  }),
);

const deleteArtifactsFilters: Array<Record<string, unknown>> = [];
let deleteArtifactsError: { message: string } | null = null;

type DeleteChain = {
  eq: (col: string, val: unknown) => DeleteChain;
  then: (resolve: (v: { error: { message: string } | null }) => unknown) => unknown;
};

function runArtifactsDeleteChain(): DeleteChain {
  const filters: Record<string, unknown> = {};
  const chain: DeleteChain = {
    eq: vi.fn((col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    }),
    then: (resolve: (v: { error: { message: string } | null }) => unknown) => {
      deleteArtifactsFilters.push(filters);
      return resolve({ error: deleteArtifactsError });
    },
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn((table: string) => {
      if (table === "run_artifacts") {
        return { delete: vi.fn(() => runArtifactsDeleteChain()) };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(async () => ({ data: priorRows, error: priorError })),
              })),
            })),
          })),
        })),
      };
    }),
    rpc: (...args: unknown[]) => rpcMock(...(args as [])),
  }),
}));

const logEventMock = vi.fn(async () => {});
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (...args: unknown[]) => logEventMock(...(args as [])),
}));

import {
  competitorSnapshotPostProcess,
  computeBrandDelta,
  isQuietWeekDelta,
  normalizeBrandKey,
  extractBrands,
  extractWhatChangedNarrative,
  isCompetitorIntelWeeklyPayload,
  mondayUtc,
  NO_MATERIAL_CHANGE_REPORT,
} from "../persist-snapshot";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: TENANT,
    runId: RUN_ID,
    trigger: "cron",
    ...overrides,
  } as unknown as AgentContext;
}

function report(brands: string[], markdownBody?: string): Record<string, unknown> {
  const blocks: unknown[] = [
    {
      type: "competitive_table",
      rows: brands.map((brand) => ({ brand, positioning: "p", gap: "g", citations: [] })),
    },
  ];
  if (markdownBody) blocks.push({ type: "markdown", body_md: markdownBody });
  return { kind: "report", template: "landscape", blocks };
}

function result(parsed: unknown, parse_ok = true, output_text = ""): DispatcherResult {
  return { parse_ok, parsed, output_text } as unknown as DispatcherResult;
}

const GOOD_PAYLOAD = { source: "competitor_intel_weekly", memory: {}, ask: "x" };

beforeEach(() => {
  vi.clearAllMocks();
  priorRows = [];
  priorError = null;
  deleteArtifactsFilters.length = 0;
  deleteArtifactsError = null;
  rpcMock.mockResolvedValue({ data: "new-id", error: null });
});

describe("competitorSnapshotPostProcess — gating", () => {
  it("persists on a gated success (kind=report, cron, right source)", async () => {
    const parsed = report(["Turo", "Getaround"]);
    await competitorSnapshotPostProcess(ctx(), result(parsed), GOOD_PAYLOAD);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe("upsert_competitor_snapshot");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_source_run_id).toBe(RUN_ID);
    expect(args.p_landscape).toBe(parsed);
    expect(args.p_week_bucket).toBe(mondayUtc(new Date()));
  });

  it("skips chat triggers", async () => {
    await competitorSnapshotPostProcess(
      ctx({ trigger: "chat" } as Partial<AgentContext>),
      result(report(["Turo"])),
      GOOD_PAYLOAD,
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("skips wrong-source payloads (ordinary research runs untouched)", async () => {
    await competitorSnapshotPostProcess(ctx(), result(report(["Turo"])), {
      source: "something_else",
    });
    expect(rpcMock).not.toHaveBeenCalled();
    await competitorSnapshotPostProcess(ctx(), result(report(["Turo"])), undefined);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("skips clarification envelopes", async () => {
    await competitorSnapshotPostProcess(
      ctx(),
      result({ kind: "clarification", questions: [] }),
      GOOD_PAYLOAD,
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("skips failed runs (parse_ok=false / parsed null)", async () => {
    await competitorSnapshotPostProcess(ctx(), result(null, false), GOOD_PAYLOAD);
    await competitorSnapshotPostProcess(ctx(), result(report(["Turo"]), false), GOOD_PAYLOAD);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("never throws when the RPC errors (post-processor contract)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      competitorSnapshotPostProcess(ctx(), result(report(["Turo"])), GOOD_PAYLOAD),
    ).resolves.toBeUndefined();
  });
});

describe("competitorSnapshotPostProcess — delta", () => {
  it("first run (no prior) → delta is null", async () => {
    priorRows = [];
    await competitorSnapshotPostProcess(ctx(), result(report(["Turo"])), GOOD_PAYLOAD);
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args.p_delta).toBeNull();
  });

  it("with a prior → deterministic added/removed brand diff + narrative", async () => {
    priorRows = [{ week_bucket: "2026-06-01", landscape: report(["Turo", "Hertz"]) }];
    const md = "## What changed this week\nGetaround entered the market.\n\n## Next section\nx";
    await competitorSnapshotPostProcess(
      ctx(),
      result(report(["Turo", "Getaround"], md)),
      GOOD_PAYLOAD,
    );
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const delta = args.p_delta as {
      added_brands: string[];
      removed_brands: string[];
      narrative_md: string | null;
    };
    expect(delta.added_brands).toEqual(["Getaround"]);
    expect(delta.removed_brands).toEqual(["Hertz"]);
    expect(delta.narrative_md).toBe("Getaround entered the market.");
  });

  it("prior exists but has NO extractable brands → suppress chips (no all-added fabrication)", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: { kind: "report", blocks: [] } }];
    const md = "## What changed this week\nNothing structural moved.\n";
    await competitorSnapshotPostProcess(
      ctx(),
      result(report(["Turo", "Hertz", "Getaround"], md)),
      GOOD_PAYLOAD,
    );
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const delta = args.p_delta as {
      added_brands: string[];
      removed_brands: string[];
      narrative_md: string | null;
    };
    expect(delta.added_brands).toEqual([]);
    expect(delta.removed_brands).toEqual([]);
    expect(delta.narrative_md).toBe("Nothing structural moved.");
  });

  it("re-worded labels (qualifier appended) don't churn as removed+added", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: report(["Preply", "Cuemath"]) }];
    await competitorSnapshotPostProcess(
      ctx(),
      result(report(["Preply (direct)", "Cuemath (direct)", "Hindi Ai (NEW)"])),
      GOOD_PAYLOAD,
    );
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const delta = args.p_delta as { added_brands: string[]; removed_brands: string[] };
    expect(delta.added_brands).toEqual(["Hindi Ai (NEW)"]);
    expect(delta.removed_brands).toEqual([]);
  });

  it("prior read error → persists with delta null (no fabricated all-added diff)", async () => {
    priorError = { message: "read failed" };
    await competitorSnapshotPostProcess(ctx(), result(report(["Turo"])), GOOD_PAYLOAD);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args.p_delta).toBeNull();
  });
});

describe("Slice 2 — deterministic quiet-week delivery suppression", () => {
  it("empty delta + prior (clean diff) → suppresses the operator brief, STILL persists the snapshot", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: report(["Turo", "Hertz"]) }];
    const res = result(report(["Turo", "Hertz"]), true, "## Full manufactured brief\n2-3 moves...");
    await competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args.p_landscape).toBe(res.parsed);
    const delta = args.p_delta as { added_brands: string[]; removed_brands: string[] };
    expect(delta.added_brands).toEqual([]);
    expect(delta.removed_brands).toEqual([]);

    expect(res.output_text).toBe(NO_MATERIAL_CHANGE_REPORT);
    expect(logEventMock).toHaveBeenCalledTimes(1);

    expect(deleteArtifactsFilters).toHaveLength(1);
    expect(deleteArtifactsFilters[0]).toEqual({
      tenant_id: TENANT,
      run_id: RUN_ID,
      mime: "application/pdf",
    });
  });

  it("first scan (no prior) → ALWAYS surfaces; NO artifact delete", async () => {
    priorRows = [];
    const res = result(report(["Turo", "Getaround"]), true, "Seed landscape brief.");
    await competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(res.output_text).toBe("Seed landscape brief.");
    expect(logEventMock).not.toHaveBeenCalled();
    expect(deleteArtifactsFilters).toHaveLength(0);
  });

  it("non-empty delta (real change) → surfaces the full brief; NO artifact delete", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: report(["Turo", "Hertz"]) }];
    const res = result(report(["Turo", "Getaround"]), true, "Real change brief with moves.");
    await competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD);
    expect(res.output_text).toBe("Real change brief with moves.");
    expect(logEventMock).not.toHaveBeenCalled();
    expect(deleteArtifactsFilters).toHaveLength(0);
  });

  it("empty brand diff but a real narrative → surfaces; NO artifact delete (narrative is a material signal)", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: report(["Turo", "Hertz"]) }];
    const md = "## What changed this week\nTuro cut weekly pricing 15%.\n";
    const res = result(report(["Turo", "Hertz"], md), true, "Brief noting the pricing move.");
    await competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD);
    expect(res.output_text).toBe("Brief noting the pricing move.");
    expect(logEventMock).not.toHaveBeenCalled();
    expect(deleteArtifactsFilters).toHaveLength(0);
  });

  it("fail-safe: degraded prior (unreadable competitive set) → surfaces; NO artifact delete", async () => {
    priorRows = [{ week_bucket: "2026-06-08", landscape: { kind: "report", blocks: [] } }];
    const res = result(report(["Turo", "Hertz"]), true, "Brief on an unreadable-prior week.");
    await competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(res.output_text).toBe("Brief on an unreadable-prior week.");
    expect(logEventMock).not.toHaveBeenCalled();
    expect(deleteArtifactsFilters).toHaveLength(0);
  });

  it("fail-safe: an artifact-delete ERROR does NOT break suppression or snapshot persist", async () => {
    deleteArtifactsError = { message: "artifact delete boom" };
    priorRows = [{ week_bucket: "2026-06-08", landscape: report(["Turo", "Hertz"]) }];
    const res = result(report(["Turo", "Hertz"]), true, "## Full brief\nmoves...");
    await expect(
      competitorSnapshotPostProcess(ctx(), res, GOOD_PAYLOAD),
    ).resolves.toBeUndefined();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(res.output_text).toBe(NO_MATERIAL_CHANGE_REPORT);
    expect(deleteArtifactsFilters).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  it("isCompetitorIntelWeeklyPayload matches only the exact source marker", () => {
    expect(isCompetitorIntelWeeklyPayload({ source: "competitor_intel_weekly" })).toBe(true);
    expect(isCompetitorIntelWeeklyPayload({ source: "qa_weekly_execute" })).toBe(false);
    expect(isCompetitorIntelWeeklyPayload(null)).toBe(false);
    expect(isCompetitorIntelWeeklyPayload("competitor_intel_weekly")).toBe(false);
  });

  it("extractBrands reads competitive_table rows, dedupes case-insensitively", () => {
    const landscape = {
      blocks: [
        {
          type: "competitive_table",
          rows: [{ brand: "Turo" }, { brand: " turo " }, { brand: "Getaround" }],
        },
      ],
    };
    expect(extractBrands(landscape)).toEqual(["Turo", "Getaround"]);
  });

  it("extractBrands falls back to cards_grid titles when no competitive_table rows", () => {
    const landscape = {
      blocks: [{ type: "cards_grid", cards: [{ title: "Hertz" }, { title: "Avis" }] }],
    };
    expect(extractBrands(landscape)).toEqual(["Hertz", "Avis"]);
  });

  it("extractWhatChangedNarrative falls back to output_text when no markdown block", () => {
    const txt = "intro\n### What changed this week\nPrices dropped 10%.\n### Sources\n[1]";
    expect(extractWhatChangedNarrative({ blocks: [] }, txt)).toBe("Prices dropped 10%.");
  });

  it("extractWhatChangedNarrative returns null when the block is absent", () => {
    expect(extractWhatChangedNarrative(report(["Turo"]), "no delta here")).toBeNull();
  });

  it("computeBrandDelta is case-insensitive and order-preserving", () => {
    const d = computeBrandDelta(["Turo", "Getaround"], ["turo", "Hertz"], null);
    expect(d.added_brands).toEqual(["Getaround"]);
    expect(d.removed_brands).toEqual(["Hertz"]);
  });

  it("normalizeBrandKey strips trailing qualifiers but keeps distinct base names", () => {
    expect(normalizeBrandKey("Preply (direct)")).toBe("preply");
    expect(normalizeBrandKey("Preply")).toBe("preply");
    expect(normalizeBrandKey("Getaround (US — DEFUNCT)")).toBe("getaround");
    expect(normalizeBrandKey("Hertz / Enterprise / Avis (Big Rental)")).toBe(
      "hertz / enterprise / avis",
    );
    expect(normalizeBrandKey("(unknown)")).toBe("(unknown)");
  });

  it("computeBrandDelta matches on the qualifier-stripped base name", () => {
    const d = computeBrandDelta(
      ["Preply (direct)", "Cuemath (direct)", "Hindi Ai (NEW)"],
      ["Preply", "Cuemath"],
      null,
    );
    expect(d.added_brands).toEqual(["Hindi Ai (NEW)"]);
    expect(d.removed_brands).toEqual([]);
  });

  it("isQuietWeekDelta — true only on a clean-empty delta; any signal → false", () => {
    expect(isQuietWeekDelta({ added_brands: [], removed_brands: [], narrative_md: null })).toBe(
      true,
    );
    expect(isQuietWeekDelta({ added_brands: [], removed_brands: [], narrative_md: "  " })).toBe(
      true,
    );
    expect(
      isQuietWeekDelta({ added_brands: ["X"], removed_brands: [], narrative_md: null }),
    ).toBe(false);
    expect(
      isQuietWeekDelta({ added_brands: [], removed_brands: ["Y"], narrative_md: null }),
    ).toBe(false);
    expect(
      isQuietWeekDelta({ added_brands: [], removed_brands: [], narrative_md: "Prices moved." }),
    ).toBe(false);
  });

  it("mondayUtc returns the Monday of the containing week (UTC)", () => {
    expect(mondayUtc(new Date("2026-06-10T12:00:00Z"))).toBe("2026-06-08");
    expect(mondayUtc(new Date("2026-06-08T00:00:00Z"))).toBe("2026-06-08");
    expect(mondayUtc(new Date("2026-06-14T23:59:59Z"))).toBe("2026-06-08");
  });
});
