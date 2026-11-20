import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type Tables = {
  system_config: { data: unknown; error: unknown };
  tenants: { data: unknown; error: unknown };
  tenant_credit_balances: { data: unknown; error: unknown };
  tenant_subscriptions: { data: unknown; error: unknown };
};

const world: { tables: Tables; reads: string[] } = {
  tables: {} as Tables,
  reads: [],
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: keyof Tables) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            world.reads.push(table);
            const t = world.tables[table];
            if (!t) throw new Error(`unexpected table ${table}`);
            return t;
          },
        }),
      }),
    }),
  }),
}));

import {
  refineProduct,
  realRefineProductDeps,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import {
  InsufficientCreditsForBuild,
  requiredBuildCredits,
  requiredRefineCredits,
} from "@/services/agents/build-credit-preflight";
import { testSite } from "./fixtures/refine-site";

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function wallet(opts: {
  enforced?: boolean;
  unlimited?: boolean;
  allowance: number;
  used?: number;
  purchased?: number;
  reserved?: number;
  plan?: string;
  tier?: string | null;
  balanceError?: boolean;
}): Tables {
  return {
    system_config: {
      data: { blob: { credits_enforced: opts.enforced ?? true, free_daily_credits: 1000 } },
      error: null,
    },
    tenants: { data: { credits_unlimited: opts.unlimited ?? false }, error: null },
    tenant_credit_balances: opts.balanceError
      ? { data: null, error: { message: "db blip" } }
      : {
          data: {
            included_allowance: opts.allowance,
            included_used: opts.used ?? 0,
            purchased_balance: opts.purchased ?? 0,
            reserved: opts.reserved ?? 0,
            period_end: tomorrow(),
          },
          error: null,
        },
    tenant_subscriptions: {
      data: { plan: opts.plan ?? "free", status: "active", tier: opts.tier ?? null, comp_expires_at: null },
      error: null,
    },
  };
}

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: "t1" })]),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue(null),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi
      .fn()
      .mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    readBalance: vi.fn(realRefineProductDeps.readBalance!),
  } as unknown as MockDeps;
}

const INPUT = { tenant_id: "t1", message: "make the header sticky in the top corner" };

beforeEach(() => {
  world.reads = [];
});

describe("refineProduct credit preflight through the real wallet reader", () => {
  it("the refine bar is the engineer reserve, below the whole-build bar", () => {
    expect(requiredRefineCredits()).toBe(2000);
    expect(requiredRefineCredits()).toBeLessThan(requiredBuildCredits());
  });

  it("a free tenant on its 1,000 daily grant is refused with a typed 402 error before any slot is taken", async () => {
    world.tables = wallet({ allowance: 1000, used: 200 });
    const d = deps();
    const err = await refineProduct(INPUT, d).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsForBuild);
    expect(err.required_credits).toBe(2000);
    expect(err.remaining_credits).toBe(800);
    expect(world.reads).toContain("tenant_credit_balances");
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    expect(d.loadPriorRefines).not.toHaveBeenCalled();
  });

  it("open holds count against the wallet: allowance covers the reserve only before other runs hold credits", async () => {
    world.tables = wallet({ allowance: 8000, used: 5000, reserved: 1500, plan: "team", tier: "starter" });
    const d = deps();
    await expect(refineProduct(INPUT, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("a paid tenant with 5,000 left can refine even though it could not start a whole build", async () => {
    world.tables = wallet({ allowance: 8000, used: 3000, plan: "team", tier: "starter" });
    const d = deps();
    const r = await refineProduct(INPUT, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });

  it("purchased credits clear the bar for a free tenant", async () => {
    world.tables = wallet({ allowance: 1000, purchased: 1500 });
    const d = deps();
    await refineProduct(INPUT, d);
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });

  it("an unlimited tenant, an unenforced tenant and an unreadable balance are never refused", async () => {
    for (const t of [
      wallet({ allowance: 0, unlimited: true }),
      wallet({ allowance: 0, enforced: false }),
      wallet({ allowance: 0, balanceError: true }),
    ]) {
      world.tables = t;
      const d = deps();
      await refineProduct(INPUT, d);
      expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
    }
  });
});
