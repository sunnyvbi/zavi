import { describe, expect, it } from "vitest";
import { payoutSetupLine } from "./CreatorEarnings";

const line = (status: string, amount_cents: number, bucket: "held" | "on_the_way" | "paid" = "held") => ({
  order_id: `${status}-${amount_cents}`,
  title: null,
  status,
  bucket,
  price_cents: amount_cents,
  creator_fee_cents: 0,
  amount_cents,
  part_paid: false,
  currency: "usd",
  payout_ready_at: null,
  closed_at: null,
});

describe("payoutSetupLine: the set-up-payouts nudge matches where the money is", () => {
  it("says approved money is waiting, not that it comes when the business approves", () => {
    expect(payoutSetupLine([line("completed", 12750)])).toBe(
      "$127.50 is approved and waiting for you. Set up payouts with Stripe so it can reach your bank.",
    );
  });

  it("splits approved and still-running money", () => {
    expect(payoutSetupLine([line("completed", 12750), line("in_progress", 8500)])).toMatch(
      /^\$127\.50 is approved and waiting for you, and \$85 follows when the business approves the rest\./,
    );
  });

  it("keeps the running-job wording when nothing is approved yet, and ignores money already paid", () => {
    expect(payoutSetupLine([line("in_progress", 8500), line("completed", 5000, "paid")])).toBe(
      "You accepted a job. Set up payouts with Stripe so $85 can reach your bank when the business approves.",
    );
  });
});
