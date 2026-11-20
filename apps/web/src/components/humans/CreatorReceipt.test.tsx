// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CreatorReceipt } from "./CreatorReceipt";
import type { CreatorJobReceipt } from "./creatorJobTypes";

const ORDER = "22222222-2222-2222-2222-222222222222";
const base: CreatorJobReceipt = {
  currency: "usd",
  price_cents: 15_000,
  business_fee_cents: 1_500,
  business_total_cents: 16_500,
  refunded_cents: 0,
  paid_at: "2026-09-02T12:00:00Z",
  receipt_url: "https://pay.stripe.com/receipts/r1",
  chargeback_status: null,
};

afterEach(cleanup);

describe("CreatorReceipt", () => {
  it("shows price, fee and the charged total, with the Stripe link", () => {
    render(<CreatorReceipt receipt={base} orderId={ORDER} />);
    expect(screen.getByText("$150.00")).toBeTruthy();
    expect(screen.getByText("$15.00")).toBeTruthy();
    expect(screen.getByText("$165.00")).toBeTruthy();
    expect(screen.getByText(/Job #22222222/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Stripe receipt" }).getAttribute("href")).toBe(base.receipt_url);
    expect(screen.queryByText("Refunded")).toBeNull();
  });

  it("adds the refund and what was actually paid", () => {
    render(<CreatorReceipt receipt={{ ...base, refunded_cents: 5_000 }} orderId={ORDER} />);
    expect(screen.getByText("Refunded")).toBeTruthy();
    expect(screen.getByText("-$50.00")).toBeTruthy();
    expect(screen.getByText("$115.00")).toBeTruthy();
  });

  it("says a card dispute holds the payout", () => {
    render(<CreatorReceipt receipt={{ ...base, chargeback_status: "open" }} orderId={ORDER} />);
    expect(screen.getByText(/Your bank is disputing this charge/)).toBeTruthy();
  });

  it("still renders without a Stripe link", () => {
    render(<CreatorReceipt receipt={{ ...base, receipt_url: null }} orderId={ORDER} />);
    expect(screen.queryByRole("link", { name: "Stripe receipt" })).toBeNull();
    expect(screen.getByText("$165.00")).toBeTruthy();
  });
});
