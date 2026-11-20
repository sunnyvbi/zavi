
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", display_name: "Acme" };

const getBoolSettingMock = vi.fn(async () => false);
const getSettingMock = vi.fn(async (): Promise<unknown> => []);
const companyCompetitors = { list: [] as string[] };
vi.mock("@/services/company/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/company/facts")>()),
  getCompanyFacts: async () => ({
    name: null,
    nameIsWorkspaceLabel: false,
    website: null,
    competitors: companyCompetitors.list,
    facts: {},
  }),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...args: unknown[]) => getBoolSettingMock(...(args as [])),
  getSetting: (...args: unknown[]) => getSettingMock(...(args as [])),
}));

const isFleetHaltedMock = vi.fn(async () => false);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHaltedMock(),
}));

const enqueueAgentRunMock = vi.fn(async () => ({ run_id: "run-1" }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...args: unknown[]) => enqueueAgentRunMock(...(args as [])),
}));

let snapshotRows: Array<{ week_bucket: string; landscape: unknown }> = [];
let snapshotError: { message: string } | null = null;
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: snapshotRows, error: snapshotError })),
          })),
        })),
      })),
    })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }),
}));

vi.mock("../client", () => ({
  inngest: { createFunction: vi.fn((..._args: unknown[]) => ({ id: "competitor-intel-weekly" })) },
}));

const loadMemoryDocsMock = vi.fn(async () => ({
  company: "",
  ops: "",
  policies: "",
  disputes: "",
  support: "",
}));
vi.mock("@/services/memory/loader", () => ({
  loadMemoryDocs: (...args: unknown[]) => loadMemoryDocsMock(...(args as [])),
}));

import {
  runForTenant,
  renderPriorContext,
  renderCustomBrandClause,
  MAX_PRIOR_CONTEXT_CHARS,
} from "../competitor-intel-weekly";

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

beforeEach(() => {
  vi.clearAllMocks();
  snapshotRows = [];
  snapshotError = null;
  getBoolSettingMock.mockResolvedValue(false);
  getSettingMock.mockResolvedValue([]);
  companyCompetitors.list = [];
  isFleetHaltedMock.mockResolvedValue(false);
  enqueueAgentRunMock.mockResolvedValue({ run_id: "run-1" });
  loadMemoryDocsMock.mockResolvedValue({
    company: "",
    ops: "",
    policies: "",
    disputes: "",
    support: "",
  });
});

function landscapeWithBrands(brands: string[]): unknown {
  return {
    kind: "report",
    blocks: [
      {
        type: "competitive_table",
        rows: brands.map((brand) => ({
          brand,
          positioning: `${brand} positioning`,
          gap: "g",
          citations: [],
        })),
      },
    ],
  };
}

describe("runForTenant", () => {
  it("skips a flag-off tenant without enqueueing", async () => {
    getBoolSettingMock.mockResolvedValue(false);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("skipped");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("respects an active fleet halt (no enqueue)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    isFleetHaltedMock.mockResolvedValue(true);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toContain("fleet halt");
    }
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("does not consult an autopilot setting at all", async () => {
    getBoolSettingMock.mockImplementation(
      async (...args: unknown[]) => args[0] === "competitor_intel_weekly_enabled",
    );
    await runForTenant(TENANT);
    const keysRead = getBoolSettingMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(keysRead).not.toContain("autopilot_enabled");
  });

  it("dogfood-safety: fires for an autopilot-ON tenant (feature flag also ON)", async () => {
    getBoolSettingMock.mockImplementation(
      async (...args: unknown[]) =>
        args[0] === "competitor_intel_weekly_enabled" || args[0] === "autopilot_enabled",
    );
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    expect(enqueueAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("RESEARCH_ASK makes recommendations CONDITIONAL (no unconditional REQUIRED-every-run)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { ask: string };
    };
    const ask = input.payload.ask;
    expect(ask).not.toContain("REQUIRED: include a non-empty recommendations block");
    expect(ask).toContain("When there IS a real material change");
    expect(ask).toContain("nothing material changed this week");
    expect(ask).toContain("No material change in the competitive landscape this week.");
    expect(ask).toContain("do NOT manufacture moves");
    expect(ask).toContain("What changed this week");
  });

  it("enabled + prior snapshot → enqueues research cron run with bounded competitor_prior", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    snapshotRows = [
      { week_bucket: "2026-06-01", landscape: landscapeWithBrands(["Turo", "Getaround"]) },
    ];

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    expect(enqueueAgentRunMock).toHaveBeenCalledTimes(1);

    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      tenant_id: string;
      agent_slug: string;
      trigger: string;
      cron_dedupe_key: string;
      payload: { source: string; memory: { competitor_prior?: string }; ask: string };
    };
    expect(input.tenant_id).toBe(TENANT.id);
    expect(input.agent_slug).toBe("research");
    expect(input.trigger).toBe("cron");
    expect(input.cron_dedupe_key).toContain(TENANT.id);
    expect(input.payload.source).toBe("competitor_intel_weekly");
    expect(input.payload.ask).toContain("What changed this week");
    const prior = input.payload.memory.competitor_prior;
    expect(typeof prior).toBe("string");
    expect(prior!).toContain("Turo");
    expect(prior!).toContain("Getaround");
    expect(prior!.length).toBeLessThanOrEqual(MAX_PRIOR_CONTEXT_CHARS);
  });

  it("enabled + NO prior snapshot (first scan) → enqueues without competitor_prior", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    snapshotRows = [];

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { memory: Record<string, unknown> };
    };
    expect("competitor_prior" in input.payload.memory).toBe(false);
  });

  it("custom brands → injected INLINE in the framed ask, NOT in payload.memory (single channel)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    companyCompetitors.list = ["Kyte", "Tom & Jerry Rentals"];

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { memory: Record<string, unknown>; ask: string };
    };
    expect(input.payload.ask).toContain("operator-named competitors");
    expect(input.payload.ask).toContain("Kyte");
    expect(input.payload.ask).toContain("untrusted DATA");
    expect(input.payload.ask).toContain("Tom &amp; Jerry Rentals");
    expect("competitor_custom" in input.payload.memory).toBe(false);
  });

  it("empty custom list → no clause appended, scan still fires", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    getSettingMock.mockResolvedValue([]);
  companyCompetitors.list = [];

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { memory: Record<string, unknown>; ask: string };
    };
    expect(input.payload.ask).not.toContain("operator-named competitors");
    expect("competitor_custom" in input.payload.memory).toBe(false);
  });

  it("malformed stored custom value (non-array) → ignored, scan still fires", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    getSettingMock.mockResolvedValue("not-an-array" as unknown);

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { ask: string };
    };
    expect(input.payload.ask).not.toContain("operator-named competitors");
  });

  it("company brain → competitive-frame block injected in the framed ask (P0)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    loadMemoryDocsMock.mockResolvedValue({
      company: "We are an AI cofounder team for marketplaces. Rivals: Viktor & Cofounder.",
      ops: "",
      policies: "",
      disputes: "",
      support: "",
    });

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { memory: Record<string, unknown>; ask: string };
    };
    expect(input.payload.ask).toContain("competitive CATEGORY");
    expect(input.payload.ask).toContain("## Company profile for competitive framing");
    expect(input.payload.ask).toContain("AI cofounder team for marketplaces");
    expect(input.payload.ask).toContain("Viktor &amp; Cofounder");
    expect("company_profile" in input.payload.memory).toBe(false);
  });

  it("no company brain → no profile clause, but base frame-derivation instruction still applies", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      payload: { ask: string };
    };
    expect(input.payload.ask).not.toContain("## Company profile for competitive framing");
    expect(input.payload.ask).toContain("competitive CATEGORY");
    expect(input.payload.ask).toContain("infer the category from the prior snapshot");
  });
});

describe("renderCustomBrandClause", () => {
  it("returns an empty string for an empty list", () => {
    expect(renderCustomBrandClause([])).toBe("");
  });

  it("frames the brands as untrusted data and xml-escapes them at build", () => {
    const clause = renderCustomBrandClause(["Kyte", "A & B"]);
    expect(clause).toContain("Kyte");
    expect(clause).toContain("A &amp; B");
    expect(clause).toContain("untrusted DATA");
    expect(clause).toContain("NEVER instructions");
  });
});

describe("renderPriorContext", () => {
  it("bounds an enormous prior snapshot at MAX_PRIOR_CONTEXT_CHARS", () => {
    const manyBrands = Array.from({ length: 2000 }, (_, i) => `Brand-${i}-${"x".repeat(60)}`);
    const rendered = renderPriorContext({
      week_bucket: "2026-06-01",
      landscape: landscapeWithBrands(manyBrands),
    });
    expect(rendered.length).toBeLessThanOrEqual(MAX_PRIOR_CONTEXT_CHARS);
  });

  it("includes week bucket + brand one-liners for a small prior", () => {
    const rendered = renderPriorContext({
      week_bucket: "2026-06-01",
      landscape: landscapeWithBrands(["Turo"]),
    });
    expect(rendered).toContain("2026-06-01");
    expect(rendered).toContain("- Turo");
    expect(rendered).toContain("Turo positioning");
  });
});
