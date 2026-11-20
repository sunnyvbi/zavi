
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCohortExecute = vi.fn();
vi.mock("@/services/tools/growth/read_cohort", () => ({
  readCohortTool: { execute: (...a: unknown[]) => mockCohortExecute(...a) },
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: () => Promise.resolve(false),
}));

import { build } from "../growth-lead";
import type { DashboardContext } from "../_contract";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

function ctx(): DashboardContext {
  const chain: Record<string, unknown> = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
  };
  return {
    tenantId: TENANT_A,
    accessToken: "tok",
    ctx: { tenant_id: TENANT_A },
    sb: chain,
  } as unknown as DashboardContext;
}

type Cohort = {
  cohort: string;
  signups: number;
  revenue: number | null;
  revenue_per_signup: number | null;
  payback_ratio: number | null;
};

async function cohortsOf(): Promise<Cohort[]> {
  const d = (await build(ctx())) as { cohorts?: { rows?: Cohort[] } };
  return d.cohorts?.rows ?? [];
}

beforeEach(() => mockCohortExecute.mockReset());

describe("growth-lead dashboard — cohort projection keeps unknown unknown", () => {
  it("payback_ratio: null survives as null, never 0", async () => {
    mockCohortExecute.mockResolvedValue({
      connected: true,
      currency: "usd",
      cohorts: [
        { cohort: "2026-08", signups: 12, revenue: 480, revenue_per_signup: 40, payback_ratio: null },
        { cohort: "2026-07", signups: 9, revenue: 270, revenue_per_signup: 30, payback_ratio: null },
      ],
    });
    const rows = await cohortsOf();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.payback_ratio).toBeNull();
      expect(r.payback_ratio).not.toBe(0);
    }
  });

  it("revenue / revenue_per_signup: null survives as null, never 0", async () => {
    mockCohortExecute.mockResolvedValue({
      connected: true,
      currency: "usd",
      cohorts: [
        { cohort: "2026-08", signups: 0, revenue: null, revenue_per_signup: null, payback_ratio: null },
      ],
    });
    const [r] = await cohortsOf();
    expect(r.revenue).toBeNull();
    expect(r.revenue_per_signup).toBeNull();
    expect(r.payback_ratio).toBeNull();
  });

  it("a real measured payback still comes through as a number", async () => {
    mockCohortExecute.mockResolvedValue({
      connected: true,
      currency: "usd",
      cohorts: [
        { cohort: "2026-08", signups: 20, revenue: 1000, revenue_per_signup: 50, payback_ratio: 1.25 },
        { cohort: "2026-07", signups: 4, revenue: 0, revenue_per_signup: 0, payback_ratio: 0 },
      ],
    });
    const rows = await cohortsOf();
    expect(rows[0].payback_ratio).toBe(1.25);
    expect(rows[0].revenue_per_signup).toBe(50);
    expect(rows[1].payback_ratio).toBe(0);
    expect(rows[1].revenue).toBe(0);
  });

  it("a non-numeric field (string/undefined) becomes null, not NaN or 0", async () => {
    mockCohortExecute.mockResolvedValue({
      connected: true,
      cohorts: [{ cohort: "2026-08", signups: 3, revenue: "480", payback_ratio: undefined }],
    });
    const [r] = await cohortsOf();
    expect(r.revenue).toBeNull();
    expect(r.payback_ratio).toBeNull();
    expect(r.revenue_per_signup).toBeNull();
    expect(r.signups).toBe(3);
  });
});
