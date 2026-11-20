import { describe, expect, it } from "vitest";
import { acceptedOfferIsPaid } from "./CreatorThread";

describe("creator offer card: no job until it is paid", () => {
  it("links to Jobs only once the business has paid an accepted offer", () => {
    expect(acceptedOfferIsPaid({ status: "accepted", awaiting_payment: true })).toBe(false);
    expect(acceptedOfferIsPaid({ status: "accepted" })).toBe(false);
    expect(acceptedOfferIsPaid({ status: "accepted", awaiting_payment: false })).toBe(true);
  });

  it("an accepted offer that closed unpaid is not paid and has no Jobs link", () => {
    expect(acceptedOfferIsPaid({ status: "accepted", awaiting_payment: false, closed_unpaid: true })).toBe(false);
  });
});
