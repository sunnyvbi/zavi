
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const disputesRetrieve = vi.fn();
const chargesList = vi.fn();
const chargesRetrieve = vi.fn();

const fakeStripe = {
  disputes: { retrieve: disputesRetrieve },
  charges: { list: chargesList, retrieve: chargesRetrieve },
} as const;

vi.mock("@/services/tools/stripe/_client", async (orig) => {
  const actual = (await orig()) as typeof import("../../../services/tools/stripe/_client");
  return {
    ...actual,
    stripeClient: async () => fakeStripe as never,
  };
});

import { retrieveDisputeTool } from "@/services/tools/stripe/retrieve_dispute";

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  log: () => {},
};

const DAY = 86400;
const T = 1_700_000_000;

function charge(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ch_x",
    amount: 10000,
    currency: "usd",
    created: T,
    customer: "cus_1",
    payment_method: "pm_123",
    paid: true,
    status: "succeeded",
    refunded: false,
    disputed: false,
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    ...over,
  };
}

const disputedCharge = charge({ id: "ch_disputed", created: T });

beforeEach(() => {
  disputesRetrieve.mockReset();
  chargesList.mockReset();
  chargesRetrieve.mockReset();
  disputesRetrieve.mockResolvedValue({
    id: "dp_1",
    amount: 10000,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    charge: disputedCharge,
    evidence: {},
    evidence_details: { due_by: T + 7 * DAY, past_due: false, submission_count: 0 },
  });
});

describe("retrieve_dispute — CE 3.0 / selective-dispute signal", () => {
  it("buckets prior-undisputed-same-PM, applies the 120–365d window, and excludes self/different-PM/refunded/disputed", async () => {
    chargesList.mockResolvedValue({
      data: [
        disputedCharge,
        charge({ id: "ch_w1", created: T - 200 * DAY }),
        charge({ id: "ch_w2", created: T - 300 * DAY }),
        charge({ id: "ch_recent", created: T - 40 * DAY }),
        charge({ id: "ch_ref", created: T - 200 * DAY, refunded: true }),
        charge({ id: "ch_disp", created: T - 200 * DAY, disputed: true }),
        charge({ id: "ch_otherpm", created: T - 200 * DAY, payment_method: "pm_other" }),
      ],
      has_more: false,
    });

    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;

    expect(out.buyer.prior_undisputed_same_pm.total).toBe(3);
    expect(out.buyer.prior_undisputed_same_pm.in_ce3_window_120_365d).toBe(2);
    expect(out.buyer.accepted_charges_same_pm).toBe(3);
    expect(out.buyer.disputed_charges_same_pm).toBe(1);
    expect(out.charge.payment_method).toBe("pm_123");
  });

  it("self-exclusion regression — the disputed charge itself is NOT counted in prior_dispute_count", async () => {
    chargesList.mockResolvedValue({
      data: [
        charge({ id: "ch_disputed", created: T, disputed: true }),
        charge({ id: "ch_a", created: T - 200 * DAY, disputed: true }),
      ],
      has_more: false,
    });

    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;
    expect(out.buyer.prior_dispute_count).toBe(1);
  });

  it("no qualifying priors — all different-PM / too-recent / refunded / disputed → zeros + stable shape", async () => {
    chargesList.mockResolvedValue({
      data: [
        charge({ id: "ch_recent", created: T - 10 * DAY }),
        charge({ id: "ch_ref", created: T - 200 * DAY, refunded: true }),
        charge({ id: "ch_disp", created: T - 200 * DAY, disputed: true }),
        charge({ id: "ch_otherpm", created: T - 200 * DAY, payment_method: "pm_other" }),
      ],
      has_more: false,
    });

    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;
    expect(out.buyer.prior_undisputed_same_pm.in_ce3_window_120_365d).toBe(0);
    expect(out.buyer.prior_undisputed_same_pm.total).toBe(1);
    expect(out.buyer.disputed_charges_same_pm).toBe(1);
  });

  it("no customer on the charge — all counts 0, conservative matching default, no throw", async () => {
    disputesRetrieve.mockResolvedValue({
      id: "dp_1",
      amount: 10000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      charge: charge({ id: "ch_disputed", customer: null }),
      evidence: {},
      evidence_details: { due_by: T + 7 * DAY, past_due: false, submission_count: 0 },
    });

    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;
    expect(out.buyer.customer_id).toBeNull();
    expect(out.buyer.prior_dispute_count).toBe(0);
    expect(out.buyer.prior_undisputed_same_pm.total).toBe(0);
    expect(out.buyer.prior_undisputed_same_pm.in_ce3_window_120_365d).toBe(0);
    expect(out.buyer.matching_data_available).toEqual({ ip: false, device: false });
    expect(chargesList).not.toHaveBeenCalled();
  });

  it("matching_data_available is always the conservative {ip:false, device:false} default (never fabricated from a bare charge)", async () => {
    chargesList.mockResolvedValue({ data: [], has_more: false });
    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;
    expect(out.buyer.matching_data_available.ip).toBe(false);
    expect(out.buyer.matching_data_available.device).toBe(false);
  });

  it("best-effort on truncated history (has_more:true) — returns counts, does not throw", async () => {
    chargesList.mockResolvedValue({
      data: [charge({ id: "ch_w1", created: T - 200 * DAY })],
      has_more: true,
    });
    const out = (await retrieveDisputeTool.execute(ctx, { dispute_id: "dp_1" })) as any;
    expect(out.buyer.prior_undisputed_same_pm.in_ce3_window_120_365d).toBe(1);
  });
});

const AGENT_MD = path.join(process.cwd(), "src", "agents", "dispute-response", "agent.md");

function readAgentMd(): { fm: Record<string, unknown>; body: string } {
  const raw = readFileSync(AGENT_MD, "utf-8");
  const parsed = matter(raw);
  return { fm: parsed.data as Record<string, unknown>, body: parsed.content };
}

function declaredTools(fm: Record<string, unknown>): string[] {
  const praxis = (fm.metadata as { praxis?: Record<string, unknown> } | undefined)?.praxis;
  const tools = (praxis?.tools as unknown[]) ?? [];
  return Array.isArray(tools) ? (tools as string[]) : [];
}

describe("dispute-response agent.md — Phase-1 prompt contract", () => {
  it("declares stripe__list_charges and NOT the stale stripe__list_charge_history", () => {
    const { fm } = readAgentMd();
    const tools = declaredTools(fm);
    expect(tools).toContain("stripe__list_charges");
    expect(tools).not.toContain("stripe__list_charge_history");
  });

  it("contains the CE 3.0 block (compelling evidence, 120/365 window, same payment method, IP-or-device, do-not-overstate)", () => {
    const { body } = readAgentMd();
    const lc = body.toLowerCase();
    expect(lc).toMatch(/compelling evidence|ce 3\.0/);
    expect(body).toContain("120");
    expect(body).toContain("365");
    expect(lc).toContain("same payment method");
    expect(lc).toMatch(/at least one/);
    expect(lc).toMatch(/ip/);
    expect(lc).toMatch(/device/);
    expect(lc).toMatch(/do not claim|never overstate/);
  });

  it("contains selective-dispute framing referencing accepted_charges_same_pm", () => {
    const { body } = readAgentMd();
    const lc = body.toLowerCase();
    expect(lc).toContain("selective");
    expect(body).toContain("accepted_charges_same_pm");
  });

  it("contains the calibrated win-probability EV rubric (High/Medium/Low, ~$500 accept threshold, accept_dispute, serial-disputer exception)", () => {
    const { body } = readAgentMd();
    expect(body).toMatch(/High/);
    expect(body).toMatch(/Medium/);
    expect(body).toMatch(/Low/);
    expect(body).toMatch(/\$500/);
    expect(body).toContain("accept_dispute");
    expect(body.toLowerCase()).toMatch(/serial-disputer/);
  });

  it("contains the Stripe evidence field-map with real field names AND the PII guard", () => {
    const { body } = readAgentMd();
    for (const field of [
      "customer_communication",
      "customer_purchase_ip",
      "service_documentation",
      "receipt",
      "shipping_documentation",
      "uncategorized_text",
    ]) {
      expect(body).toContain(field);
    }
    expect(body).toContain("customer_name");
    expect(body).toContain("customer_email_address");
    expect(body.toLowerCase()).toMatch(/never emit/);
  });
});
