
import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeDispute = Record<string, unknown>;
const TENANT_DISPUTES: Record<
  string,
  { open: FakeDispute[]; recent: FakeDispute[] }
> = {};

vi.mock("@/services/tools/stripe/_client", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    stripeClient: async (tenantId: string) => {
      const data = TENANT_DISPUTES[tenantId];
      if (!data) throw new Error("stripe_not_connected");
      return {
        disputes: {
          list: async (params: { created?: unknown; limit?: number }) => ({
            data: params?.created ? data.recent : data.open,
          }),
        },
      } as never;
    },
  };
});

import { build } from "../dispute-response";
import type { DashboardContext } from "../_contract";

function ctx(tenantId: string): DashboardContext {
  return { tenantId } as unknown as DashboardContext;
}

const NOW = Math.floor(Date.now() / 1000);
const D = 86400;

function openDispute(over: Partial<FakeDispute> = {}): FakeDispute {
  return {
    id: "dp_default",
    amount: 50000,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    evidence_details: {
      due_by: NOW + 5 * D,
      past_due: false,
      has_evidence: false,
      submission_count: 0,
    },
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(TENANT_DISPUTES)) delete TENANT_DISPUTES[k];
});

describe("dispute-response dashboard — evidence-readiness richness", () => {
  it("surfaces Stripe's CE 3.0 verdict + humanized required-action gaps verbatim", async () => {
    TENANT_DISPUTES["tenant-A"] = {
      open: [
        openDispute({
          id: "dp_ce3_action",
          evidence_details: {
            due_by: NOW + 3 * D,
            past_due: false,
            has_evidence: false,
            submission_count: 0,
            enhanced_eligibility: {
              visa_compelling_evidence_3: {
                status: "requires_action",
                required_actions: [
                  "missing_prior_undisputed_transactions",
                  "missing_customer_identifiers",
                ],
              },
            },
          },
        }),
      ],
      recent: [],
    };

    const out = (await build(ctx("tenant-A"))) as {
      open: Array<{
        id: string;
        ce3_status: string;
        ce3_required_actions: string[];
        has_evidence: boolean;
        submission_count: number;
      }>;
    };

    const dp = out.open.find((d) => d.id === "dp_ce3_action")!;
    expect(dp.ce3_status).toBe("requires_action");
    expect(dp.ce3_required_actions).toEqual([
      "Add 2+ prior undisputed transactions (120–365d old)",
      "Add customer identifiers (email / IP / device)",
    ]);
    expect(dp.has_evidence).toBe(false);
    expect(dp.submission_count).toBe(0);
  });

  it("maps qualified / not_qualified / absent enhanced_eligibility to a safe status", async () => {
    TENANT_DISPUTES["tenant-A"] = {
      open: [
        openDispute({
          id: "dp_qualified",
          evidence_details: {
            due_by: NOW + 2 * D,
            has_evidence: true,
            submission_count: 0,
            enhanced_eligibility: {
              visa_compelling_evidence_3: { status: "qualified", required_actions: [] },
            },
          },
        }),
        openDispute({
          id: "dp_no_signal",
          evidence_details: { due_by: NOW + 4 * D, has_evidence: false, submission_count: 0 },
        }),
      ],
      recent: [],
    };

    const out = (await build(ctx("tenant-A"))) as {
      open: Array<{ id: string; ce3_status: string; has_evidence: boolean }>;
    };
    const q = out.open.find((d) => d.id === "dp_qualified")!;
    const n = out.open.find((d) => d.id === "dp_no_signal")!;
    expect(q.ce3_status).toBe("qualified");
    expect(q.has_evidence).toBe(true);
    expect(n.ce3_status).toBe("n/a");
  });

  it("empty / first-time: connected tenant with no open disputes returns an empty docket, not a throw", async () => {
    TENANT_DISPUTES["tenant-A"] = { open: [], recent: [] };
    const out = (await build(ctx("tenant-A"))) as {
      connected: boolean;
      open: unknown[];
      kpis: { open_count: number };
    };
    expect(out.connected).toBe(true);
    expect(out.open).toEqual([]);
    expect(out.kpis.open_count).toBe(0);
  });

  it("not connected: a tenant with no Stripe key returns { connected:false }", async () => {
    const out = (await build(ctx("tenant-A"))) as { connected: boolean };
    expect(out.connected).toBe(false);
  });
});

describe("dispute-response dashboard — CROSS-TENANT isolation (E3)", () => {
  it("tenant A's panel carries ONLY tenant A's disputes — never tenant B's", async () => {
    TENANT_DISPUTES["tenant-A"] = {
      open: [openDispute({ id: "dp_A_only", amount: 10000 })],
      recent: [
        { id: "dp_A_won", amount: 10000, currency: "usd", reason: "fraudulent", status: "won" },
      ],
    };
    TENANT_DISPUTES["tenant-B"] = {
      open: [
        openDispute({
          id: "dp_B_secret",
          amount: 999999,
          evidence_details: {
            due_by: NOW + 1 * D,
            has_evidence: true,
            submission_count: 1,
            enhanced_eligibility: {
              visa_compelling_evidence_3: { status: "qualified", required_actions: [] },
            },
          },
        }),
      ],
      recent: [
        { id: "dp_B_won", amount: 999999, currency: "usd", reason: "fraudulent", status: "won" },
      ],
    };

    const a = (await build(ctx("tenant-A"))) as {
      open: Array<{ id: string }>;
      kpis: { recovered_usd: number; amount_at_risk_usd: number };
    };

    const ids = a.open.map((d) => d.id);
    expect(ids).toContain("dp_A_only");
    expect(ids).not.toContain("dp_B_secret");
    expect(a.kpis.amount_at_risk_usd).toBe(100);
    expect(a.kpis.recovered_usd).toBe(100);
  });
});
