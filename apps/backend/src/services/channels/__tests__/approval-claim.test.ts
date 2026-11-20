import { describe, expect, it } from "vitest";
import { cardBodyWithoutApprovalClaim, stripApprovalClaim, withoutApprovalClaim } from "../approval-claim";

describe("withoutApprovalClaim", () => {
  it("takes the claim out of the about and rationale the model wrote, keeping the rest", () => {
    const payload = {
      ad_set_id: "120258729006520059",
      daily_budget_usd: 178.8,
      about: 'Founder approved by email reply ("Yes, go ahead."): raise from $149 to $178.80 a day (+20%).',
      rationale: "Founder-approved raise. Live budget read this run: $149/day.",
    };
    expect(withoutApprovalClaim(payload)).toEqual({
      ad_set_id: "120258729006520059",
      daily_budget_usd: 178.8,
      about: "Raise from $149 to $178.80 a day (+20%).",
      rationale: "Live budget read this run: $149/day.",
    });
  });

  it("returns the same object when nothing claims an approval", () => {
    const payload = { about: "Purchase line for the spring sale.", rationale: "Best return in the account." };
    expect(withoutApprovalClaim(payload)).toBe(payload);
  });

  it("drops a field that was only the claim", () => {
    expect(stripApprovalClaim("Approved by the founder.")).toBeNull();
    expect(withoutApprovalClaim({ about: "Approved by the founder.", name: "X" })).toEqual({ name: "X" });
  });
});

describe("cardBodyWithoutApprovalClaim", () => {
  it("strips the claim from the composed step prose paragraph by paragraph, keeping the change line", () => {
    const body = {
      step: {
        title: "Raise the ad set from $149 to $178.80 a day",
        body: 'Founder approved by email reply ("Yes, go ahead."): raise from $149 to $178.80 a day\n\nRaise the ad set from $149 to $178.80 a day',
      },
      change_sentence: "Raise the ad set from $149 to $178.80 a day",
    };
    expect(cardBodyWithoutApprovalClaim(body)).toEqual({
      step: { title: "Raise the ad set from $149 to $178.80 a day", body: "Raise from $149 to $178.80 a day\n\nRaise the ad set from $149 to $178.80 a day" },
      change_sentence: "Raise the ad set from $149 to $178.80 a day",
    });
  });
  it("returns the same object when nothing claims an approval", () => {
    const body = { step: { title: "T", body: "B" } };
    expect(cardBodyWithoutApprovalClaim(body)).toBe(body);
  });
});
